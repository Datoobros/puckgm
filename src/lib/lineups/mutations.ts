// Lineups — who plays tonight, drawn from a team's ACTIVE roster only.
// Distinct from roster ownership (src/lib/rosters/mutations.ts): owning a
// player and starting him are two different questions. DESIGN.md §2.4.
//
// Slot values are unnumbered position groups ("C", "L", "R", "D", "G",
// "UTIL", "BE"), not per-slot labels like "C1"/"C2" — the schema comment on
// LineupEntry.lineupSlot uses numbered slots only as an example. Multiple
// players can share slot "C" the same day; capacity is enforced by counting
// rows per (team, date, slot) against the league's rosterComposition, not by
// the DB's uniqueness (which is only teamId+playerId+gameDate). Simpler to
// build and nothing downstream parses the string yet.
//
// Slot codes ("L"/"R") deliberately match Player.primaryPosition's stored
// values (NHL's single-letter positionCode) rather than RosterComposition's
// key names ("LW"/"RW", set at league creation — see src/app/leagues/new).
// Those two naming schemes just don't agree; capFor() bridges them.

import { prisma } from "@/lib/db";
import type { LeagueSettings, RosterComposition } from "@/lib/leagues/mutations";
import { isTeamManager } from "@/lib/leagues/mutations";
import { getTeamGamesForDate, isLocked } from "@/lib/lineups/schedule";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { todayUTC } from "@/lib/dates";

// Two eligibility maps, one per RosterComposition.positionMode. SEPARATE
// keeps C/L/R as distinct starting slots; COMBINED folds them into one "F"
// (Forwards) slot instead — everything else (D/G/UTIL/BE) is identical.
const SEPARATE_ELIGIBILITY: Record<string, string[] | null> = {
  C: ["C"],
  L: ["L"],
  R: ["R"],
  D: ["D"],
  G: ["G"],
  UTIL: ["C", "L", "R", "D"],
  BE: null, // any position can sit
};

const COMBINED_ELIGIBILITY: Record<string, string[] | null> = {
  F: ["C", "L", "R"],
  D: ["D"],
  G: ["G"],
  UTIL: ["C", "L", "R", "D"],
  BE: null,
};

type PositionMode = RosterComposition["positionMode"];

function eligibilityFor(positionMode: PositionMode): Record<string, string[] | null> {
  return positionMode === "COMBINED" ? COMBINED_ELIGIBILITY : SEPARATE_ELIGIBILITY;
}

/** Every starting slot code a league's lineup can use, in this mode — "BE"
 * included. Team roster/lineup UI reads this to know what to render. */
export function lineupSlotsFor(positionMode: PositionMode): string[] {
  return Object.keys(eligibilityFor(positionMode));
}

export function capFor(slot: string, comp: RosterComposition): number | null {
  if (slot === "BE") return null; // bench isn't capacity-limited, it's the leftover state
  if (slot === "F") return comp.F;
  if (slot === "L") return comp.LW;
  if (slot === "R") return comp.RW;
  return comp[slot as keyof Omit<RosterComposition, "positionMode">] ?? 0;
}

/** Starting slots (excluding BE, which is always available) a position can
 * fill, in the given league's position mode. */
export function eligibleSlotsForPosition(position: string | null, positionMode: PositionMode = "SEPARATE"): string[] {
  if (!position) return [];
  return Object.entries(eligibilityFor(positionMode))
    .filter(([slot, positions]) => slot !== "BE" && positions?.includes(position))
    .map(([slot]) => slot);
}

export function parseGameDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function getLineupForDate(teamId: string, date: string) {
  return prisma.lineupEntry.findMany({
    where: { teamId, gameDate: parseGameDate(date) },
  });
}

/** A player's current slot for a date, defaulting to "BE" when he has no
 * LineupEntry yet — the same default the team page's own display logic
 * already uses. No row means never placed; materialization (see
 * ensureLineupMaterialized below) runs first at every real call site, so by
 * the time this is read a no-row player has already been through auto-fill
 * and genuinely has no open eligible slot. Used by the Move UI's swap
 * dispatch to know where a displaced occupant's mover came from, without
 * trusting a client-supplied value. */
export async function getPlayerLineupSlot(teamId: string, playerId: string, date: string): Promise<string> {
  const entry = await prisma.lineupEntry.findUnique({
    where: { teamId_playerId_gameDate: { teamId, playerId, gameDate: parseGameDate(date) } },
  });
  return entry?.lineupSlot ?? "BE";
}

export interface SetLineupSlotInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  date: string; // "YYYY-MM-DD"
  slot: string;
  managerUserId: string;
}

// Shared gate chain for anything that moves one player into one lineup slot:
// team/league match -> manager -> not frozen -> slot legal for this league's
// positionMode -> player actually on the ACTIVE roster -> position eligible
// for the slot -> not locked (his own game hasn't started). setLineupSlot and
// swapLineupSlots both build on this rather than duplicating it — a swap is
// two of these checks (one per player) plus one atomic double-write.
async function loadAndValidateLineupMove(input: {
  leagueId: string;
  teamId: string;
  playerId: string;
  date: string;
  slot: string;
  managerUserId: string;
}) {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (!isTeamManager(team, input.managerUserId)) {
    throw new Error("You don't manage this team.");
  }
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — its lineup can't be edited.");

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const eligible = eligibilityFor(settings.rosterComposition.positionMode)[input.slot];
  if (eligible === undefined) throw new Error(`Unknown lineup slot "${input.slot}".`);

  const rosterSlot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
  });
  if (!rosterSlot) throw new Error("Player is not on this team's active roster.");

  if (eligible && !eligible.includes(rosterSlot.player.primaryPosition ?? "")) {
    throw new Error(`${rosterSlot.player.fullName} isn't eligible for ${input.slot}.`);
  }

  // Per-game lock: DESIGN.md §2.4 — a player locks when his own game begins,
  // nothing else. No lock at all if he has no game that day.
  if (rosterSlot.player.currentNhlOrg) {
    const games = await getTeamGamesForDate(input.date);
    const game = games.get(rosterSlot.player.currentNhlOrg);
    if (game && isLocked(game)) {
      throw new Error(`${rosterSlot.player.fullName}'s game has already started — locked for this date.`);
    }
  }

  return { team, settings, rosterSlot, gameDate: parseGameDate(input.date) };
}

/** A player sent to Farm/IR (src/lib/rosters/mutations.ts) doesn't have his
 * LineupEntry rows cleaned up for every date they might exist on — only the
 * Move UI's IR path does that, narrowly, for the one date it's acting on
 * (placeOnIrClearingLineup). Rather than chase every mutation that changes
 * ACTIVE status, slot-capacity counts are filtered to currently-active
 * players here, at the one place capacity is actually enforced — a stale
 * row left behind by an old send-down/IR move should never count against a
 * slot's capacity for anyone else. */
async function activeRosterPlayerIds(teamId: string): Promise<string[]> {
  const rows = await prisma.rosterSlot.findMany({
    where: { teamId, slotType: "ACTIVE", effectiveTo: null },
    select: { playerId: true },
  });
  return rows.map((r) => r.playerId);
}

/** A candidate for the shared slot-assignment loop below — either an
 * unlocked never-placed player (ensureLineupMaterialized's auto-fill) or an
 * unlocked player being fully re-ranked (autoSetLineup). */
interface StarterCandidate {
  playerId: string;
  primaryPosition: string | null;
  points: number;
}

/** Two invariants, enforced by this one idempotent function, that make a
 * lineup behave like ESPN's: it persists day to day until changed, and a
 * newly-eligible player lands in the first open slot rather than sitting on
 * the bench until someone notices. Called before every capacity check in
 * setLineupSlot/swapLineupSlots/autoSetLineup, on every team-page view (any
 * date), by the daily cron (yesterday + today, every team), and after every
 * interactive roster-acquisition path (addPlayerToRoster, callUpToActive,
 * activateFromIR, commissionerAddPlayer, commissionerMovePlayer-to-ACTIVE,
 * forceProcessTrade) — see PROGRESS.md for the full call-site list.
 *
 * 1. Carry-forward: if `date` has no explicit rows yet, copy the most recent
 *    earlier date's rows (filtered to players still on the ACTIVE roster) —
 *    these become "base" rows for `date`. A date with no prior date either
 *    starts from an empty base.
 * 2. Auto-fill: every active player with no row in the base (never placed —
 *    an explicit "BE" row means "benched on purpose" and is left alone) gets
 *    ranked by career fantasy points and assigned into whatever capacity is
 *    still open (position slots first, then UTIL), skipping anyone whose own
 *    game has already started. A player who has no game at all is still a
 *    valid candidate — this only cares about *locked*, unlike autoSetLineup,
 *    which explicitly deprioritizes no-game players. Nobody without a game
 *    can be locked, so this naturally allows persistent lineups to fill in
 *    even during a stretch with no NHL games at all (e.g. September).
 *
 * All reads (roster, existing/prior rows, the NHL schedule, the stats query)
 * happen before any write; both writes below go in one transaction.
 * `createMany({ skipDuplicates: true })` against the (teamId, playerId,
 * gameDate) unique key makes concurrent calls for the same team/date safe.
 */
export async function ensureLineupMaterialized(teamId: string, date: string): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: teamId }, include: { league: true } });
  if (!team) return; // defensive — every caller already validated the team exists
  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const positionMode = settings.rosterComposition.positionMode;
  const gameDate = parseGameDate(date);

  const activeSlots = await prisma.rosterSlot.findMany({
    where: { teamId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
    orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
  });
  if (activeSlots.length === 0) return;
  const activeIds = new Set(activeSlots.map((s) => s.playerId));

  const explicitRows = await prisma.lineupEntry.findMany({ where: { teamId, gameDate } });

  // Carry-forward candidates — read only, nothing written yet.
  let carryRows: { playerId: string; lineupSlot: string }[] = [];
  if (explicitRows.length === 0) {
    const priorDay = await prisma.lineupEntry.findFirst({
      where: { teamId, gameDate: { lt: gameDate } },
      orderBy: { gameDate: "desc" },
      select: { gameDate: true },
    });
    if (priorDay) {
      const priorRows = await prisma.lineupEntry.findMany({ where: { teamId, gameDate: priorDay.gameDate } });
      carryRows = priorRows.filter((r) => activeIds.has(r.playerId)).map((r) => ({ playerId: r.playerId, lineupSlot: r.lineupSlot }));
    }
  }

  const baseRows = explicitRows.length > 0
    ? explicitRows.map((r) => ({ playerId: r.playerId, lineupSlot: r.lineupSlot }))
    : carryRows;
  const placedIds = new Set(baseRows.map((r) => r.playerId));
  const unplaced = activeSlots.filter((s) => !placedIds.has(s.playerId));

  // Auto-fill candidates. Skipped entirely for a past date (nothing to
  // fill — everything that mattered was already locked by then, so
  // carry-forward alone is correct) and when nobody's actually unplaced.
  let assigned = new Map<string, string>();
  if (unplaced.length > 0 && date >= todayUTC()) {
    const teamGames = await getTeamGamesForDate(date);
    const candidates: StarterCandidate[] = [];
    for (const s of unplaced) {
      const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
      if (game && isLocked(game)) continue; // his game already started — leave unplaced, re-evaluated once a slot opens
      candidates.push({ playerId: s.playerId, primaryPosition: s.player.primaryPosition, points: 0 });
    }
    if (candidates.length > 0) {
      const rankingRows = await getPlayerStatsAggregate({
        playerIds: candidates.map((c) => c.playerId),
        scoringConfig: settings.scoringConfig,
      });
      const pointsById = new Map(rankingRows.map((r) => [r.id, r.points]));
      for (const c of candidates) c.points = pointsById.get(c.playerId) ?? 0;
      candidates.sort((a, b) => b.points - a.points);

      const positionSlots = autoSetPositionSlots(positionMode);
      const remainingCap: Record<string, number> = {};
      for (const slot of [...positionSlots, "UTIL"]) {
        const cap = capFor(slot, settings.rosterComposition) ?? 0;
        const occupiedInBase = baseRows.filter((r) => r.lineupSlot === slot && activeIds.has(r.playerId)).length;
        remainingCap[slot] = Math.max(0, cap - occupiedInBase);
      }
      assigned = assignStarters(candidates, remainingCap, positionMode);
    }
  }

  const writes: ReturnType<typeof prisma.lineupEntry.createMany>[] = [];
  if (carryRows.length > 0) {
    writes.push(
      prisma.lineupEntry.createMany({
        data: carryRows.map((r) => ({ teamId, playerId: r.playerId, gameDate, lineupSlot: r.lineupSlot })),
        skipDuplicates: true,
      }),
    );
  }
  if (assigned.size > 0) {
    writes.push(
      prisma.lineupEntry.createMany({
        data: Array.from(assigned.entries()).map(([playerId, lineupSlot]) => ({ teamId, playerId, gameDate, lineupSlot })),
        skipDuplicates: true,
      }),
    );
  }
  if (writes.length > 0) {
    await prisma.$transaction(writes);
  }
}

/** The other half of the persistent-lineup fix: a player who leaves a team's
 * active roster (drop, farm, IR, traded away) has no business still counting
 * toward that team's score — getTeamScoreForPeriod sums every non-BE row in
 * range, so a stale row left behind after he's gone would keep crediting his
 * points. Defaults to clearing from today forward (an acquisition/departure
 * happens "now," in real time) — every call site passes an explicit date only
 * when it genuinely needs a different anchor. Deliberately does NOT touch
 * anything before `fromDate`: a date already in the past is history, not to
 * be rewritten (same "dropping a locked player forfeits his points today"
 * trade-off called out in PROGRESS.md's Known gaps — ESPN would block that
 * drop outright; this app doesn't). */
export async function clearLineupFrom(teamId: string, playerId: string, fromDate: string = todayUTC()): Promise<void> {
  await prisma.lineupEntry.deleteMany({
    where: { teamId, playerId, gameDate: { gte: parseGameDate(fromDate) } },
  });
}

export async function setLineupSlot(input: SetLineupSlotInput): Promise<void> {
  await ensureLineupMaterialized(input.teamId, input.date);
  const { settings, gameDate } = await loadAndValidateLineupMove(input);

  const cap = capFor(input.slot, settings.rosterComposition);
  if (cap !== null) {
    const activeIds = await activeRosterPlayerIds(input.teamId);
    const occupied = await prisma.lineupEntry.count({
      where: {
        teamId: input.teamId,
        gameDate,
        lineupSlot: input.slot,
        playerId: { not: input.playerId, in: activeIds },
      },
    });
    if (occupied >= cap) {
      throw new Error(`All ${cap} ${input.slot} slot${cap === 1 ? "" : "s"} are already filled for this date.`);
    }
  }

  await prisma.$transaction([
    prisma.lineupEntry.upsert({
      where: { teamId_playerId_gameDate: { teamId: input.teamId, playerId: input.playerId, gameDate } },
      update: { lineupSlot: input.slot },
      create: { teamId: input.teamId, playerId: input.playerId, gameDate, lineupSlot: input.slot },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "LINEUP_EDIT",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, date: input.date, slot: input.slot },
      },
    }),
  ]);
}

export interface SwapLineupSlotsInput {
  leagueId: string;
  teamId: string;
  date: string;
  managerUserId: string;
  moverId: string;
  moverDestinationSlot: string;
  displacedPlayerId: string;
  displacedDestinationSlot: string;
}

/** Exchanges two active-roster players' lineup slots in one shot — the Move
 * UI's "drop onto an occupied slot" case. `displacedDestinationSlot` is
 * normally the mover's own current slot (a real two-way swap), but callers
 * activating an IR player into an occupied slot pass "BE" instead, since an
 * IR player has no current lineup slot of his own to hand back. */
export async function swapLineupSlots(input: SwapLineupSlotsInput): Promise<void> {
  await ensureLineupMaterialized(input.teamId, input.date);
  const [mover, displaced] = await Promise.all([
    loadAndValidateLineupMove({
      leagueId: input.leagueId,
      teamId: input.teamId,
      playerId: input.moverId,
      date: input.date,
      slot: input.moverDestinationSlot,
      managerUserId: input.managerUserId,
    }),
    loadAndValidateLineupMove({
      leagueId: input.leagueId,
      teamId: input.teamId,
      playerId: input.displacedPlayerId,
      date: input.date,
      slot: input.displacedDestinationSlot,
      managerUserId: input.managerUserId,
    }),
  ]);

  const { gameDate, settings } = mover;

  // A true swap only ever changes who's in each slot, not how many are — but
  // check capacity anyway (excluding both players, and any stale non-active
  // rows) rather than assume the caller always pairs a slot with its own
  // current occupant; a stale client-side destination list should fail
  // loudly, not silently overfill a slot.
  const activeIds = await activeRosterPlayerIds(input.teamId);
  for (const [slot, otherGameDate] of [
    [input.moverDestinationSlot, gameDate],
    [input.displacedDestinationSlot, displaced.gameDate],
  ] as const) {
    const cap = capFor(slot, settings.rosterComposition);
    if (cap === null) continue;
    const occupied = await prisma.lineupEntry.count({
      where: {
        teamId: input.teamId,
        gameDate: otherGameDate,
        lineupSlot: slot,
        playerId: { notIn: [input.moverId, input.displacedPlayerId], in: activeIds },
      },
    });
    if (occupied >= cap) {
      throw new Error(`All ${cap} ${slot} slot${cap === 1 ? "" : "s"} are already filled for this date.`);
    }
  }

  await prisma.$transaction([
    prisma.lineupEntry.upsert({
      where: { teamId_playerId_gameDate: { teamId: input.teamId, playerId: input.moverId, gameDate } },
      update: { lineupSlot: input.moverDestinationSlot },
      create: { teamId: input.teamId, playerId: input.moverId, gameDate, lineupSlot: input.moverDestinationSlot },
    }),
    prisma.lineupEntry.upsert({
      where: { teamId_playerId_gameDate: { teamId: input.teamId, playerId: input.displacedPlayerId, gameDate } },
      update: { lineupSlot: input.displacedDestinationSlot },
      create: { teamId: input.teamId, playerId: input.displacedPlayerId, gameDate, lineupSlot: input.displacedDestinationSlot },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "LINEUP_EDIT",
        actorTeamId: input.teamId,
        payload: {
          event: "SWAP",
          date: input.date,
          moverId: input.moverId,
          moverSlot: input.moverDestinationSlot,
          displacedPlayerId: input.displacedPlayerId,
          displacedSlot: input.displacedDestinationSlot,
        },
      },
    }),
  ]);
}

// Position-specific slots first (in SEPARATE mode each candidate matches at
// most one of C/L/R/D/G, so processing order among these doesn't affect the
// outcome; in COMBINED mode F/D/G plays the same role), then UTIL absorbs
// whichever eligible skaters are left over. Ranking is by career-to-date
// fantasy points — simple, uses data that's already computed, and doesn't
// depend on which "season" today's calendar date happens to bucket into
// (see src/lib/players/seasons.ts's caveat about that boundary).
function autoSetPositionSlots(positionMode: PositionMode): string[] {
  return positionMode === "COMBINED" ? ["F", "D", "G"] : ["C", "L", "R", "D", "G"];
}

/** The actual slot-assignment loop, shared by autoSetLineup (which builds
 * `remainingCap` from locked-player occupancy and calls this once per
 * candidate tier) and ensureLineupMaterialized's auto-fill step (which
 * builds it from carried-forward/explicit base rows and calls this once).
 * `candidates` must already be sorted best-to-worst by points. Mutates
 * `remainingCap` in place by decrementing whatever it assigns — callers that
 * want cumulative depletion across multiple calls (autoSetLineup's two
 * tiers) reuse the same object; a one-shot caller can just discard it after. */
function assignStarters(
  candidates: StarterCandidate[],
  remainingCap: Record<string, number>,
  positionMode: PositionMode,
): Map<string, string> {
  const positionSlots = autoSetPositionSlots(positionMode);
  const assigned = new Map<string, string>();

  for (const slot of positionSlots) {
    if ((remainingCap[slot] ?? 0) <= 0) continue;
    for (const c of candidates) {
      if ((remainingCap[slot] ?? 0) <= 0) break;
      if (assigned.has(c.playerId)) continue;
      if (!eligibleSlotsForPosition(c.primaryPosition, positionMode).includes(slot)) continue;
      assigned.set(c.playerId, slot);
      remainingCap[slot] -= 1;
    }
  }
  if ((remainingCap.UTIL ?? 0) > 0) {
    for (const c of candidates) {
      if ((remainingCap.UTIL ?? 0) <= 0) break;
      if (assigned.has(c.playerId)) continue;
      if (!eligibleSlotsForPosition(c.primaryPosition, positionMode).includes("UTIL")) continue;
      assigned.set(c.playerId, "UTIL");
      remainingCap.UTIL -= 1;
    }
  }
  return assigned;
}

export interface AutoSetLineupInput {
  leagueId: string;
  teamId: string;
  dates: string[]; // "YYYY-MM-DD"[]
  managerUserId: string;
}

export interface AutoSetLineupResult {
  date: string;
  started: { playerId: string; fullName: string; slot: string }[];
  benched: { playerId: string; fullName: string }[];
  skippedLocked: { playerId: string; fullName: string; slot: string }[];
}

/** Recomputes each given date's lineup from scratch for every unlocked
 * active-roster player — including demoting anyone previously hand-picked
 * who doesn't make the cut, matching "optimize lineup" semantics rather
 * than only ever filling empty slots. Players already locked (their game
 * has started) are left exactly as they are. Two candidate tiers, each
 * ranked by points: players with a game that date fill slots first, then
 * whatever's left goes to players without one — this is what makes Auto-Set
 * usable during a stretch with no NHL games at all (e.g. September) instead
 * of benching the entire roster, while still preferring an actual game when
 * there's a real choice between two players. */
export async function autoSetLineup(input: AutoSetLineupInput): Promise<AutoSetLineupResult[]> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (!isTeamManager(team, input.managerUserId)) {
    throw new Error("You don't manage this team.");
  }
  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const positionMode = settings.rosterComposition.positionMode;
  const positionSlots = autoSetPositionSlots(positionMode);

  const activeSlots = await prisma.rosterSlot.findMany({
    where: { teamId: input.teamId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
  });
  if (activeSlots.length === 0) return [];

  const rankingRows = await getPlayerStatsAggregate({
    playerIds: activeSlots.map((s) => s.playerId),
    scoringConfig: settings.scoringConfig,
  });
  const pointsById = new Map(rankingRows.map((r) => [r.id, r.points]));

  const results: AutoSetLineupResult[] = [];

  for (const date of input.dates) {
    // Materialize before touching capacity — otherwise a locked player who's
    // only sitting in a slot via inheritance (never an explicit row) would
    // be invisible to entryByPlayer below, remainingCap wouldn't be
    // decremented for him, and this loop could assign one more player than
    // the slot actually has room for (setLineupSlot's own capacity check
    // would then throw mid-loop once it materializes the same date itself).
    await ensureLineupMaterialized(input.teamId, date);

    const gameDate = parseGameDate(date);
    const [existingEntries, teamGames] = await Promise.all([
      prisma.lineupEntry.findMany({ where: { teamId: input.teamId, gameDate } }),
      getTeamGamesForDate(date),
    ]);
    const entryByPlayer = new Map(existingEntries.map((e) => [e.playerId, e.lineupSlot]));

    const remainingCap: Record<string, number> = {};
    for (const slot of [...positionSlots, "UTIL"]) {
      remainingCap[slot] = capFor(slot, settings.rosterComposition) ?? 0;
    }

    const skippedLocked: AutoSetLineupResult["skippedLocked"] = [];
    const withGame: StarterCandidate[] = [];
    const noGame: StarterCandidate[] = [];

    for (const s of activeSlots) {
      const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
      const locked = game ? isLocked(game) : false;
      const existingSlot = entryByPlayer.get(s.playerId) ?? "BE";

      if (locked) {
        if (existingSlot !== "BE" && remainingCap[existingSlot] !== undefined) {
          remainingCap[existingSlot] = Math.max(0, remainingCap[existingSlot] - 1);
        }
        skippedLocked.push({ playerId: s.playerId, fullName: s.player.fullName, slot: existingSlot });
        continue;
      }

      const candidate: StarterCandidate = {
        playerId: s.playerId,
        primaryPosition: s.player.primaryPosition,
        points: pointsById.get(s.playerId) ?? 0,
      };
      (game ? withGame : noGame).push(candidate);
    }

    withGame.sort((a, b) => b.points - a.points);
    noGame.sort((a, b) => b.points - a.points);

    // Tier 1 (has a game today) fills first and depletes remainingCap; tier
    // 2 (no game) only gets whatever's left over.
    const assigned = assignStarters(withGame, remainingCap, positionMode);
    for (const [playerId, slot] of assignStarters(noGame, remainingCap, positionMode)) {
      assigned.set(playerId, slot);
    }

    const started: AutoSetLineupResult["started"] = [];
    const benched: AutoSetLineupResult["benched"] = [];

    for (const s of activeSlots) {
      if (skippedLocked.some((l) => l.playerId === s.playerId)) continue;

      const slot = assigned.get(s.playerId) ?? "BE";
      const currentSlot = entryByPlayer.get(s.playerId) ?? "BE";
      if (slot !== currentSlot) {
        await setLineupSlot({
          leagueId: input.leagueId,
          teamId: input.teamId,
          playerId: s.playerId,
          date,
          slot,
          managerUserId: input.managerUserId,
        });
      }

      if (slot === "BE") benched.push({ playerId: s.playerId, fullName: s.player.fullName });
      else started.push({ playerId: s.playerId, fullName: s.player.fullName, slot });
    }

    results.push({ date, started, benched, skippedLocked });
  }

  return results;
}
