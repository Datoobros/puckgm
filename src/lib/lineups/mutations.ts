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
import { getTeamGamesForDate, isLocked } from "@/lib/lineups/schedule";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";

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

function parseGameDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function getLineupForDate(teamId: string, date: string) {
  return prisma.lineupEntry.findMany({
    where: { teamId, gameDate: parseGameDate(date) },
  });
}

export interface SetLineupSlotInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  date: string; // "YYYY-MM-DD"
  slot: string;
  managerUserId: string;
}

export async function setLineupSlot(input: SetLineupSlotInput): Promise<void> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (team.managerUserId !== input.managerUserId) {
    throw new Error("You don't manage this team.");
  }
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — its lineup can't be edited.");

  const settingsForEligibility = team.league.settingsJson as unknown as LeagueSettings;
  const eligible = eligibilityFor(settingsForEligibility.rosterComposition.positionMode)[input.slot];
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

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = capFor(input.slot, settings.rosterComposition);
  if (cap !== null) {
    const occupied = await prisma.lineupEntry.count({
      where: {
        teamId: input.teamId,
        gameDate: parseGameDate(input.date),
        lineupSlot: input.slot,
        playerId: { not: input.playerId },
      },
    });
    if (occupied >= cap) {
      throw new Error(`All ${cap} ${input.slot} slot${cap === 1 ? "" : "s"} are already filled for this date.`);
    }
  }

  const gameDate = parseGameDate(input.date);

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
 * has started) are left exactly as they are. */
export async function autoSetLineup(input: AutoSetLineupInput): Promise<AutoSetLineupResult[]> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (team.managerUserId !== input.managerUserId) {
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
    const candidates: { s: (typeof activeSlots)[number]; points: number }[] = [];

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

      if (!game) continue; // no game that date — nothing to start him for
      candidates.push({ s, points: pointsById.get(s.playerId) ?? 0 });
    }

    candidates.sort((a, b) => b.points - a.points);

    const assigned = new Map<string, string>(); // playerId -> slot
    for (const slot of positionSlots) {
      let cap = remainingCap[slot] ?? 0;
      if (cap <= 0) continue;
      for (const c of candidates) {
        if (cap <= 0) break;
        if (assigned.has(c.s.playerId)) continue;
        if (!eligibleSlotsForPosition(c.s.player.primaryPosition, positionMode).includes(slot)) continue;
        assigned.set(c.s.playerId, slot);
        cap -= 1;
      }
    }
    {
      let cap = remainingCap.UTIL ?? 0;
      for (const c of candidates) {
        if (cap <= 0) break;
        if (assigned.has(c.s.playerId)) continue;
        if (!eligibleSlotsForPosition(c.s.player.primaryPosition, positionMode).includes("UTIL")) continue;
        assigned.set(c.s.playerId, "UTIL");
        cap -= 1;
      }
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
