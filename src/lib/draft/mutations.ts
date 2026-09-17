// The draft (startup or annual rookie) — DESIGN.md §2.8.
//
// No cron involvement anywhere in this file. The live room's clock resolves
// itself on every read (resolveDraftState) — the same "compute the true
// current state fresh, never trust a stored snapshot" principle this app
// already uses for fantasy points and matchup scores, applied here to
// turn-advancement instead. Vercel Hobby's cron only fires once a day, which
// can't drive a live countdown, and this app has no other live-update
// infrastructure — so the check happens inline, every time anyone (a poller
// or a pick attempt) asks "what's the state right now," looped so it catches
// up through several missed picks in one call rather than needing one call
// per miss.
//
// Autopick ranks by career fantasy points for a STARTUP draft (real NHL
// players with real stats — same ranking autoSetLineup already uses) but
// falls back to real NHL draft position for a ROOKIE draft, since a
// freshly-ingested prospect has zero GameStatLine rows and would tie at 0
// points with every other prospect — real draft order (lower overall pick =
// considered the better prospect) is the closest honest proxy available.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isLeagueCommissioner, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getLeagueOwnershipMap, activeRosterCap } from "@/lib/rosters/ownership";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";

// Resolver lease (draft-fix-batch Task 1) — how long resolveDraftState holds
// exclusive rights to autopick for a draft before another caller is allowed
// to try. Comfortably longer than MAX_AUTOPICKS_PER_CALL picks should ever
// take, short enough that a crashed resolver doesn't wedge the draft for long.
const LEASE_MS = 15_000;
// Bounded catch-up (draft-fix-batch Task 1) — replaces the old unbounded
// "loop until settled" (which is what let a single request resolve 58
// overdue picks — and their N-way-raced duplicates — in one call the first
// time this went wrong for real). Each autopick costs a pool computation, so
// this keeps a single request comfortably inside serverless time limits; the
// client keeps polling and the next call picks up where this one left off.
const MAX_AUTOPICKS_PER_CALL = 8;

export interface SetUpDraftInput {
  leagueId: string;
  season: number;
  type: "STARTUP" | "ROOKIE";
  roundCount: number;
  orderMode: "RANDOM" | "MANUAL";
  manualOrder?: string[]; // team IDs, the round-1 order — required if orderMode is MANUAL
  pickTimerSeconds: number;
  callerUserId: string;
}

export async function setUpDraft(input: SetUpDraftInput): Promise<{ draftId: string }> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can set up a draft.");
  }

  const existing = await prisma.draft.findUnique({
    where: { leagueId_season_type: { leagueId: input.leagueId, season: input.season, type: input.type } },
  });
  if (existing) throw new Error(`A ${input.type.toLowerCase()} draft already exists for ${input.season}.`);

  const teams = await prisma.team.findMany({ where: { leagueId: input.leagueId } });
  if (teams.length < 2) throw new Error("Need at least two teams to run a draft.");
  if (!Number.isInteger(input.roundCount) || input.roundCount < 1) {
    throw new Error("Round count must be at least 1.");
  }
  if (!Number.isInteger(input.pickTimerSeconds) || input.pickTimerSeconds < 10) {
    throw new Error("Pick timer must be at least 10 seconds.");
  }
  const maxRounds = await getMaxDraftRounds(input.leagueId);
  if (input.roundCount > maxRounds) {
    throw new Error(
      `This league's rosters have room for at most ${maxRounds} more players per team — reduce the round count.`,
    );
  }

  let order: string[];
  if (input.orderMode === "RANDOM") {
    order = teams.map((t) => t.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } else {
    const teamIds = new Set(teams.map((t) => t.id));
    const given = input.manualOrder ?? [];
    if (given.length !== teams.length || new Set(given).size !== teams.length || !given.every((id) => teamIds.has(id))) {
      throw new Error("Manual order must list every team in the league exactly once.");
    }
    order = given;
  }

  if (input.type === "ROOKIE") {
    const prospectCount = await prisma.player.count({ where: { draftYear: input.season } });
    if (prospectCount === 0) {
      throw new Error(
        `No draft class ingested for ${input.season} yet — run "npx tsx scripts/ingest-draft-class.ts ${input.season}" first.`,
      );
    }
  }

  const draft = await prisma.draft.create({
    data: {
      leagueId: input.leagueId,
      season: input.season,
      type: input.type,
      pickTimerSeconds: input.pickTimerSeconds,
      status: "SETUP",
    },
  });

  // Snake order: round 2 reverses round 1's order, round 3 matches round 1,
  // etc. overallPick is the global sequence — the lowest overallPick with no
  // usedOnPlayerId is always whoever's on the clock.
  const pickRows: Prisma.DraftPickCreateManyInput[] = [];
  let overallPick = 1;
  for (let round = 1; round <= input.roundCount; round++) {
    const roundOrder = round % 2 === 1 ? order : [...order].reverse();
    for (const teamId of roundOrder) {
      pickRows.push({
        leagueId: input.leagueId,
        season: input.season,
        round,
        originalTeamId: teamId,
        currentOwnerId: teamId,
        overallPick: overallPick++,
        draftId: draft.id,
      });
    }
  }
  await prisma.draftPick.createMany({ data: pickRows });

  return { draftId: draft.id };
}

async function assertNoPickEverTraded(draftId: string): Promise<void> {
  const everTraded = await prisma.tradeItem.count({ where: { draftPick: { draftId } } });
  if (everTraded > 0) {
    throw new Error("A pick from this draft has been traded — its round count and order can no longer be edited.");
  }
}

export interface UpdateDraftSetupInput {
  draftId: string;
  callerUserId: string;
  roundCount?: number;
  orderMode?: "RANDOM" | "MANUAL";
  manualOrder?: string[];
  pickTimerSeconds?: number;
}

/** Commissioner-only, SETUP-only. Diffs DraftPick rows in place (updates
 * existing rows' round/team, adds/removes only the delta) rather than
 * deleting and recreating — TradeItem.draftPickId has no cascade, so
 * deleting a pick ever referenced by a TradeItem (any trade state, not just
 * currently pending) would throw an FK violation. assertNoPickEverTraded
 * blocks the whole edit outright in that case instead. */
export async function updateDraftSetup(input: UpdateDraftSetupInput): Promise<void> {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  if (!(await isLeagueCommissioner(draft.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can edit a draft's setup.");
  }
  if (draft.status !== "SETUP") throw new Error("Only a not-yet-started draft can be edited.");
  await assertNoPickEverTraded(draft.id);

  const teams = await prisma.team.findMany({ where: { leagueId: draft.leagueId } });
  const existingPicks = await prisma.draftPick.findMany({ where: { draftId: draft.id }, orderBy: { overallPick: "asc" } });
  const currentRoundCount = existingPicks.length / teams.length;
  const currentOrder = existingPicks.filter((p) => p.round === 1).map((p) => p.originalTeamId);

  const roundCount = input.roundCount ?? currentRoundCount;
  if (!Number.isInteger(roundCount) || roundCount < 1) throw new Error("Round count must be at least 1.");
  const pickTimerSeconds = input.pickTimerSeconds ?? draft.pickTimerSeconds;
  if (!Number.isInteger(pickTimerSeconds) || pickTimerSeconds < 10) throw new Error("Pick timer must be at least 10 seconds.");
  const maxRounds = await getMaxDraftRounds(draft.leagueId);
  if (roundCount > maxRounds) {
    throw new Error(
      `This league's rosters have room for at most ${maxRounds} more players per team — reduce the round count.`,
    );
  }

  let order: string[];
  if (input.orderMode === undefined) {
    order = currentOrder;
  } else if (input.orderMode === "RANDOM") {
    order = teams.map((t) => t.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } else {
    const teamIds = new Set(teams.map((t) => t.id));
    const given = input.manualOrder ?? currentOrder;
    if (given.length !== teams.length || new Set(given).size !== teams.length || !given.every((id) => teamIds.has(id))) {
      throw new Error("Manual order must list every team in the league exactly once.");
    }
    order = given;
  }

  const desired: { round: number; overallPick: number; teamId: string }[] = [];
  let overallPick = 1;
  for (let round = 1; round <= roundCount; round++) {
    const roundOrder = round % 2 === 1 ? order : [...order].reverse();
    for (const teamId of roundOrder) desired.push({ round, overallPick: overallPick++, teamId });
  }

  await prisma.$transaction(async (tx) => {
    for (const d of desired) {
      const existing = existingPicks.find((p) => p.overallPick === d.overallPick);
      if (existing) {
        await tx.draftPick.update({
          where: { id: existing.id },
          data: { round: d.round, originalTeamId: d.teamId, currentOwnerId: d.teamId },
        });
      } else {
        await tx.draftPick.create({
          data: {
            leagueId: draft.leagueId,
            season: draft.season,
            round: d.round,
            originalTeamId: d.teamId,
            currentOwnerId: d.teamId,
            overallPick: d.overallPick,
            draftId: draft.id,
          },
        });
      }
    }
    const desiredOveralls = new Set(desired.map((d) => d.overallPick));
    const toRemove = existingPicks.filter((p) => !desiredOveralls.has(p.overallPick!));
    if (toRemove.length > 0) {
      await tx.draftPick.deleteMany({ where: { id: { in: toRemove.map((p) => p.id) } } });
    }
    await tx.draft.update({ where: { id: draft.id }, data: { pickTimerSeconds } });
  });
}

/** Deletes a whole not-yet-started draft. Same trade-safety guard as
 * updateDraftSetup — refuses if any pick has ever been traded. */
export async function cancelDraftSetup(input: { draftId: string; callerUserId: string }): Promise<void> {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  if (!(await isLeagueCommissioner(draft.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can cancel a draft.");
  }
  if (draft.status !== "SETUP") throw new Error("Only a not-yet-started draft can be cancelled.");
  await assertNoPickEverTraded(draft.id);

  await prisma.$transaction([
    prisma.draftPick.deleteMany({ where: { draftId: input.draftId } }),
    prisma.draft.delete({ where: { id: input.draftId } }),
  ]);
}

/** Reverts every traded-away, still-unused pick in the league back to its
 * original owner. Already-drafted picks are history, not touched. */
export async function resetDraftPickOwnership(leagueId: string, callerUserId: string): Promise<{ resetCount: number }> {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
    throw new Error("Only the league commissioner can reset draft pick ownership.");
  }
  const unusedPicks = await prisma.draftPick.findMany({ where: { leagueId, usedOnPlayerId: null } });
  const moved = unusedPicks.filter((p) => p.currentOwnerId !== p.originalTeamId);
  if (moved.length > 0) {
    await prisma.$transaction(
      moved.map((p) => prisma.draftPick.update({ where: { id: p.id }, data: { currentOwnerId: p.originalTeamId } })),
    );
  }
  return { resetCount: moved.length };
}

export async function startDraft(input: { draftId: string; callerUserId: string }): Promise<void> {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  if (!(await isLeagueCommissioner(draft.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can start the draft.");
  }
  if (draft.status !== "SETUP") throw new Error("This draft has already started.");

  await prisma.draft.update({
    where: { id: input.draftId },
    data: { status: "IN_PROGRESS", currentPickDeadline: new Date(Date.now() + draft.pickTimerSeconds * 1000) },
  });
}

/** How many more rounds this league's rosters can actually absorb, per team
 * — a draft creates one pick per team per round, and every pick lands
 * somewhere (ACTIVE first, then FARM, or the reverse for ROOKIE), so no
 * team can be given more rounds than its combined ACTIVE+FARM capacity has
 * room for once its *currently* rostered players (any tier — a player on
 * IR still occupies a roster spot the draft can't also fill) are accounted
 * for. The team with the fullest roster today sets the league-wide ceiling,
 * since every team gets the same number of rounds. Exposed for the setup
 * form's helper text as well as setUpDraft/updateDraftSetup's own validation. */
export async function getMaxDraftRounds(leagueId: string): Promise<number> {
  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  const capacity = activeRosterCap(settings) + settings.farmSlots;

  const teams = await prisma.team.findMany({ where: { leagueId }, select: { id: true } });
  if (teams.length === 0) return capacity;

  const openCounts = await Promise.all(
    teams.map((t) => prisma.rosterSlot.count({ where: { teamId: t.id, effectiveTo: null } })),
  );
  return Math.max(0, capacity - Math.max(...openCounts));
}

/** Which tier a freshly-drafted player lands on. STARTUP fills ACTIVE
 * first, spilling to FARM once ACTIVE is full (a new dynasty league is
 * building its whole active roster from scratch); ROOKIE fills FARM first
 * (prospects develop there), spilling to ACTIVE only once FARM is full.
 * Throws if neither tier has room — getMaxDraftRounds is what's supposed to
 * stop a draft from ever reaching that state, this is the defensive
 * backstop actually enforcing the cap at pick-recording time. */
function slotTypeForDraftPick({
  activeCount,
  farmCount,
  settings,
  draftType,
}: {
  activeCount: number;
  farmCount: number;
  settings: LeagueSettings;
  draftType: "STARTUP" | "ROOKIE";
}): "ACTIVE" | "FARM" {
  const cap = activeRosterCap(settings);
  const tiers: ("ACTIVE" | "FARM")[] = draftType === "STARTUP" ? ["ACTIVE", "FARM"] : ["FARM", "ACTIVE"];
  for (const tier of tiers) {
    if (tier === "ACTIVE" && activeCount < cap) return "ACTIVE";
    if (tier === "FARM" && farmCount < settings.farmSlots) return "FARM";
  }
  throw new Error("Roster is full — the draft has more rounds than roster spots.");
}

/** Every league has at most one draft in flight at a time in practice — this
 * prefers a SETUP/IN_PROGRESS draft over a COMPLETE one, else the most
 * recently created draft of any status, else null. */
export async function getCurrentDraft(leagueId: string) {
  const active = await prisma.draft.findFirst({
    where: { leagueId, status: { in: ["SETUP", "IN_PROGRESS"] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) return active;
  return prisma.draft.findFirst({ where: { leagueId }, orderBy: { createdAt: "desc" } });
}

export interface DraftPoolPlayer {
  id: string;
  fullName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
}

// Pool cost (draft-fix-batch Task 1) — buildView calls getDraftPool on
// every 3s poll from every open client, and the STARTUP ranking underneath
// (getPlayerStatsAggregate over the whole player pool) costs ~1.5s on its
// own. The ranked *base* list (everyone, regardless of ownership) is
// memoized per (leagueId, season, type) for 60s in this module-level Map —
// fine per serverless instance, since a stale minute only ever affects
// *ordering* among available players. Ownership filtering always reads
// live below, so a player someone just drafted never lingers as available.
const POOL_CACHE_TTL_MS = 60_000;
const draftPoolBaseCache = new Map<string, { base: DraftPoolPlayer[]; expiresAt: number }>();

async function getRankedDraftPoolBase(draft: { leagueId: string; type: "STARTUP" | "ROOKIE"; season: number }): Promise<DraftPoolPlayer[]> {
  const cacheKey = `${draft.leagueId}:${draft.season}:${draft.type}`;
  const cached = draftPoolBaseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.base;

  const base: DraftPoolPlayer[] =
    draft.type === "STARTUP"
      ? (await getPlayerStatsAggregate()) // full pool, pre-sorted desc by career points
          .map((r) => ({ id: r.id, fullName: r.fullName, primaryPosition: r.primaryPosition, currentNhlOrg: r.currentNhlOrg }))
      : (
          await prisma.player.findMany({
            where: { draftYear: draft.season },
            orderBy: { draftOverallPick: "asc" },
          })
        ).map((p) => ({ id: p.id, fullName: p.fullName, primaryPosition: p.primaryPosition, currentNhlOrg: p.currentNhlOrg }));

  draftPoolBaseCache.set(cacheKey, { base, expiresAt: Date.now() + POOL_CACHE_TTL_MS });
  return base;
}

/** Already sorted by autopick priority — pool[0] is what autopick takes.
 * teamId is accepted but unused for now; Task 2's needs-aware ranking will
 * use it to reorder the pool by that specific team's positional needs. */
export async function getDraftPool(
  draft: { leagueId: string; type: "STARTUP" | "ROOKIE"; season: number },
  teamId?: string,
): Promise<DraftPoolPlayer[]> {
  const base = await getRankedDraftPoolBase(draft);
  const ownership = await getLeagueOwnershipMap(draft.leagueId, base.map((p) => p.id));
  return base.filter((p) => !ownership.has(p.id));
}

async function getCurrentPick(draftId: string) {
  return prisma.draftPick.findFirst({
    where: { draftId, usedOnPlayerId: null },
    orderBy: { overallPick: "asc" },
    include: { currentOwner: true },
  });
}

type PendingPick = NonNullable<Awaited<ReturnType<typeof getCurrentPick>>>;
type DraftRow = Awaited<ReturnType<typeof prisma.draft.findUniqueOrThrow>>;

/** Thrown by recordPick when another caller (a concurrent autopick, or a
 * manual pick that landed first) already claimed this exact pick — never a
 * corruption, always a race the caller is expected to recover from by
 * simply re-reading the current state. This is what the botched draft
 * needed and didn't have: nothing before this made "claim this pick" atomic,
 * so two callers could both see the same unused pick and both record it. */
class PickAlreadyTakenError extends Error {
  constructor() {
    super("This pick was already recorded by another caller.");
    this.name = "PickAlreadyTakenError";
  }
}

/** Atomic pick claim (draft-fix-batch Task 1). Everything happens in one
 * transaction: the updateMany's WHERE usedOnPlayerId: null is what makes
 * the claim itself atomic under Postgres row locking — a second concurrent
 * transaction targeting the same pick blocks until the first commits, then
 * re-evaluates the WHERE clause, sees usedOnPlayerId already set, and
 * updates zero rows. slotType is decided from counts read inside this same
 * transaction, immediately before the roster slot is created, so two
 * concurrent picks for the *same team* can't both see "room in ACTIVE" and
 * both land there. ensureLineupMaterialized is deliberately not called here
 * — unchanged from the team-page batch's decision that the first team-page
 * view after the draft auto-fills the whole roster at once. */
async function recordPick(draft: DraftRow, pick: PendingPick, playerId: string, autopicked: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.draftPick.updateMany({
      where: { id: pick.id, usedOnPlayerId: null },
      data: { usedOnPlayerId: playerId },
    });
    if (claim.count !== 1) throw new PickAlreadyTakenError();

    // Defensive: this should be unreachable (the pool this player came from
    // already excludes anyone rostered) — but if it ever isn't, roll the
    // claim back rather than double-roster someone.
    const alreadyRostered = await tx.rosterSlot.count({
      where: { playerId, effectiveTo: null, team: { leagueId: draft.leagueId } },
    });
    if (alreadyRostered > 0) {
      throw new Error("That player is already rostered in this league — the draft pool was stale.");
    }

    const league = await tx.league.findUniqueOrThrow({ where: { id: draft.leagueId } });
    const settings = league.settingsJson as unknown as LeagueSettings;
    const [activeCount, farmCount] = await Promise.all([
      tx.rosterSlot.count({ where: { teamId: pick.currentOwnerId, slotType: "ACTIVE", effectiveTo: null } }),
      tx.rosterSlot.count({ where: { teamId: pick.currentOwnerId, slotType: "FARM", effectiveTo: null } }),
    ]);
    const slotType = slotTypeForDraftPick({ activeCount, farmCount, settings, draftType: draft.type });

    await tx.rosterSlot.create({ data: { teamId: pick.currentOwnerId, playerId, slotType } });
    await tx.transactionLog.create({
      data: {
        leagueId: draft.leagueId,
        type: "DRAFT_PICK",
        actorTeamId: pick.currentOwnerId,
        payload: { playerId, round: pick.round, overallPick: pick.overallPick, autopicked, slotType },
      },
    });
  });
}

/** Moves the clock to the next unused pick, or completes the draft if none
 * remain. On a timely manual pick, the next team gets a fresh full window
 * starting now. On an autopick (the previous deadline had already passed),
 * the next deadline chains from *that* missed deadline rather than from now
 * — otherwise a long absence would only ever resolve one pick per call
 * (every autopick would hand the next team a fresh not-yet-expired window),
 * defeating the whole point of looping to catch up. */
async function advanceDeadline(draft: DraftRow, chainFromExpiredDeadline?: Date): Promise<void> {
  const next = await getCurrentPick(draft.id);
  if (next) {
    const base = chainFromExpiredDeadline ?? new Date();
    await prisma.draft.update({
      where: { id: draft.id },
      data: { currentPickDeadline: new Date(base.getTime() + draft.pickTimerSeconds * 1000) },
    });
  } else {
    await prisma.draft.update({ where: { id: draft.id }, data: { status: "COMPLETE", currentPickDeadline: null } });
  }
}

export interface DraftStateView {
  draftId: string;
  status: "SETUP" | "IN_PROGRESS" | "COMPLETE";
  pickTimerSeconds: number;
  totalRounds: number;
  totalPicks: number;
  currentPick: { round: number; overallPick: number; teamId: string; teamName: string; msRemaining: number } | null;
  recentPicks: { round: number; overallPick: number; teamName: string; playerName: string; autopicked: boolean }[];
  pool: DraftPoolPlayer[];
}

async function buildView(draft: DraftRow): Promise<DraftStateView> {
  const current = draft.status === "IN_PROGRESS" ? await getCurrentPick(draft.id) : null;
  const pool = draft.status === "IN_PROGRESS" ? await getDraftPool(draft) : [];
  const [totalPicks, lastPick] = await Promise.all([
    prisma.draftPick.count({ where: { draftId: draft.id } }),
    prisma.draftPick.findFirst({ where: { draftId: draft.id }, orderBy: { round: "desc" } }),
  ]);
  const totalRounds = lastPick?.round ?? 0;
  const recent = await prisma.draftPick.findMany({
    where: { draftId: draft.id, usedOnPlayerId: { not: null } },
    orderBy: { overallPick: "desc" },
    take: 15,
    include: { currentOwner: true, usedOnPlayer: true },
  });
  // autopicked isn't stored on DraftPick itself (only in the TransactionLog
  // payload) — cheap enough to look up the handful of recent rows shown here.
  const logs = await prisma.transactionLog.findMany({
    where: { leagueId: draft.leagueId, type: "DRAFT_PICK", actorTeamId: { in: recent.map((p) => p.currentOwnerId) } },
    orderBy: { createdAt: "desc" },
    take: recent.length * 2,
  });
  const autopickedByOverall = new Map<number, boolean>();
  for (const log of logs) {
    const payload = log.payload as { overallPick?: number; autopicked?: boolean };
    if (payload.overallPick !== undefined && !autopickedByOverall.has(payload.overallPick)) {
      autopickedByOverall.set(payload.overallPick, !!payload.autopicked);
    }
  }

  return {
    draftId: draft.id,
    status: draft.status,
    pickTimerSeconds: draft.pickTimerSeconds,
    totalRounds,
    totalPicks,
    currentPick: current
      ? {
          round: current.round,
          overallPick: current.overallPick!,
          teamId: current.currentOwnerId,
          teamName: current.currentOwner.name,
          msRemaining: draft.currentPickDeadline ? draft.currentPickDeadline.getTime() - Date.now() : 0,
        }
      : null,
    recentPicks: recent.map((p) => ({
      round: p.round,
      overallPick: p.overallPick!,
      teamName: p.currentOwner.name,
      playerName: p.usedOnPlayer!.fullName,
      autopicked: autopickedByOverall.get(p.overallPick!) ?? false,
    })),
    pool,
  };
}

/** The read-time resolver — every poll and every pick attempt calls this
 * first. This is the piece the botched draft exposed as unsafe: every
 * caller used to loop autopicking on its own, unbounded and unsynchronized,
 * so a stretch nobody was watching (the clock only advances on read) turned
 * into every poller racing to catch up through the same overdue picks at
 * once, each one duplicating what the others had already recorded. Now:
 * only one caller at a time is allowed to actually autopick for a given
 * draft (the resolvingUntil lease below), and it does at most
 * MAX_AUTOPICKS_PER_CALL picks before returning — the client keeps polling
 * and the next call (by this caller or another) continues where it left
 * off, instead of one request trying to resolve an unbounded backlog. */
export async function resolveDraftState(draftId: string): Promise<DraftStateView> {
  const initial = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
  if (initial.status !== "IN_PROGRESS") return buildView(initial);

  const currentPick = await getCurrentPick(draftId);
  const overdue = !currentPick || (initial.currentPickDeadline !== null && initial.currentPickDeadline <= new Date());
  if (!overdue) return buildView(initial);

  // Try to become the sole resolver for this draft for the next LEASE_MS.
  // If another caller already holds the lease, just return the current
  // view — the polling client will see that caller's progress on its next
  // tick, rather than this call also racing to autopick the same picks.
  const now = new Date();
  const claimed = await prisma.draft.updateMany({
    where: { id: draftId, status: "IN_PROGRESS", OR: [{ resolvingUntil: null }, { resolvingUntil: { lt: now } }] },
    data: { resolvingUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) {
    return buildView(await prisma.draft.findUniqueOrThrow({ where: { id: draftId } }));
  }

  try {
    for (let i = 0; i < MAX_AUTOPICKS_PER_CALL; i++) {
      const draft = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
      if (draft.status !== "IN_PROGRESS") break;

      const current = await getCurrentPick(draftId);
      if (!current) {
        await prisma.draft.update({ where: { id: draftId }, data: { status: "COMPLETE", currentPickDeadline: null } });
        break;
      }
      if (!draft.currentPickDeadline || draft.currentPickDeadline > new Date()) break;

      const pool = await getDraftPool(draft);
      const top = pool[0];
      if (!top) throw new Error("No players left in the draft pool to autopick.");
      try {
        await recordPick(draft, current, top.id, true);
      } catch (err) {
        // Someone else (a manual pick that isn't lease-gated) recorded this
        // exact pick between our read and our write — re-read and continue
        // rather than treat a normal race as a failure.
        if (err instanceof PickAlreadyTakenError) continue;
        throw err;
      }
      await advanceDeadline(draft, draft.currentPickDeadline);
    }
  } finally {
    await prisma.draft.updateMany({ where: { id: draftId }, data: { resolvingUntil: null } });
  }

  return buildView(await prisma.draft.findUniqueOrThrow({ where: { id: draftId } }));
}

export interface MakeDraftPickInput {
  draftId: string;
  playerId: string;
  managerUserId: string;
}

export async function makeDraftPick(input: MakeDraftPickInput): Promise<void> {
  // Resolves any expired picks first, so a manager can never pick out of
  // turn against stale client state — if autopick already took their pick
  // because they were too slow, this call sees that before checking anything.
  await resolveDraftState(input.draftId);

  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  if (draft.status !== "IN_PROGRESS") throw new Error("This draft isn't currently live.");

  const current = await getCurrentPick(input.draftId);
  if (!current) throw new Error("The draft is already complete.");
  if (!isTeamManager(current.currentOwner, input.managerUserId)) {
    throw new Error("It's not your turn.");
  }

  const pool = await getDraftPool(draft);
  if (!pool.some((p) => p.id === input.playerId)) {
    throw new Error("That player isn't available.");
  }

  try {
    await recordPick(draft, current, input.playerId, false);
  } catch (err) {
    if (err instanceof PickAlreadyTakenError) {
      throw new Error("That pick was just made — the board has moved on.");
    }
    throw err;
  }
  await advanceDeadline(draft);
}

export interface TeamDraftPickRow {
  id: string;
  season: number;
  round: number;
  overallPick: number | null;
  isOwnPick: boolean;
  originalTeamName: string;
  used: boolean;
  usedOnPlayerName: string | null;
}

/** Read-only — every pick this team currently owns, own or acquired via
 * trade, drafted or not. Used/unused and own/acquired are both worth
 * showing plainly rather than filtering, since a team's full pick
 * situation (not just what's left to use) is the point of this view. */
export async function getTeamDraftPicks(teamId: string): Promise<TeamDraftPickRow[]> {
  const picks = await prisma.draftPick.findMany({
    where: { currentOwnerId: teamId },
    include: { originalTeam: true, usedOnPlayer: true },
    orderBy: [{ season: "asc" }, { round: "asc" }],
  });
  return picks.map((p) => ({
    id: p.id,
    season: p.season,
    round: p.round,
    overallPick: p.overallPick,
    isOwnPick: p.originalTeamId === teamId,
    originalTeamName: p.originalTeam.name,
    used: p.usedOnPlayerId !== null,
    usedOnPlayerName: p.usedOnPlayer?.fullName ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Free agency gate (issue #5, plans/team-page-batch.md Task 3). Lives here,
// not in src/lib/rosters/mutations.ts, because it's draft-state-derived and
// rosters/mutations.ts (plus faab/mutations.ts, waivers/mutations.ts) needs
// to import it — putting it in rosters/mutations.ts would create the exact
// cycle getLeagueOwnershipMap's move to rosters/ownership.ts was meant to
// avoid (this file already depended on rosters/mutations.ts for that read).
// ---------------------------------------------------------------------------

export type FreeAgencyReason = "DRAFT_IN_PROGRESS" | "NO_STARTUP_DRAFT";
export type FreeAgencyStatus = { open: true } | { open: false; reason: FreeAgencyReason };

/** Closed whenever a draft is actually live, or before a league's startup
 * draft has ever completed. Checked in this order:
 *  1. Any Draft IN_PROGRESS -> DRAFT_IN_PROGRESS. The draft clock resolves
 *     on read (resolveDraftState) rather than via cron, so a draft whose
 *     timer fully ran out can sit IN_PROGRESS in the DB indefinitely until
 *     someone loads the draft room — resolve every IN_PROGRESS draft here
 *     first and re-check its real status, or a finished draft could keep
 *     free agency locked forever.
 *  2. DYNASTY: no STARTUP draft with status COMPLETE for the league, any
 *     season -> NO_STARTUP_DRAFT. Dynasty rosters persist forever once
 *     built, so only the very first startup draft ever matters here.
 *  3. REDRAFT: no STARTUP draft with status COMPLETE for the league's
 *     *current* season -> NO_STARTUP_DRAFT. startNewSeason wipes rosters
 *     and bumps currentSeason, so a redraft league correctly re-locks free
 *     agency each season until that season's own startup draft completes.
 * Otherwise open. */
export async function getFreeAgencyStatus(leagueId: string): Promise<FreeAgencyStatus> {
  const inProgressDrafts = await prisma.draft.findMany({
    where: { leagueId, status: "IN_PROGRESS" },
    select: { id: true },
  });
  for (const draft of inProgressDrafts) {
    const resolved = await resolveDraftState(draft.id);
    if (resolved.status === "IN_PROGRESS") {
      return { open: false, reason: "DRAFT_IN_PROGRESS" };
    }
  }

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;

  const completedStartup = await prisma.draft.findFirst({
    where: {
      leagueId,
      type: "STARTUP",
      status: "COMPLETE",
      ...(settings.leagueType === "REDRAFT" ? { season: league.currentSeason } : {}),
    },
  });
  if (!completedStartup) return { open: false, reason: "NO_STARTUP_DRAFT" };

  return { open: true };
}

const FREE_AGENCY_CLOSED_MESSAGE: Record<FreeAgencyReason, string> = {
  DRAFT_IN_PROGRESS: "Free agency is closed while the draft is in progress.",
  NO_STARTUP_DRAFT: "Free agency is closed until the draft is complete.",
};

/** Throws with a reason-specific message when free agency is closed —
 * called from every unowned-player acquisition path (addPlayerToRoster,
 * submitFaBid, submitWaiverClaim). Deliberately NOT called from
 * commissionerAddPlayer (an explicit override tool), recordPick (this IS
 * the draft), trade proposals (draft picks are tradeable pre-draft by
 * design), or any internal roster move (callup/IR/send-down). */
export async function assertFreeAgencyOpen(leagueId: string): Promise<void> {
  const status = await getFreeAgencyStatus(leagueId);
  if (!status.open) throw new Error(FREE_AGENCY_CLOSED_MESSAGE[status.reason]);
}

// ---------------------------------------------------------------------------
// Trade hardening (plans/trades-batch.md Task 1b, gap #6) — full trade
// freeze during a live draft, confirmed with the user: no proposals and no
// acceptances of any kind (players or picks) while any draft in the league
// is genuinely IN_PROGRESS. Lives here (not trades/mutations.ts) for the
// same reason getFreeAgencyStatus does — trades/mutations.ts imports this
// file; this file imports nothing from trades/mutations.ts (confirmed by
// grep before relying on this: this file only imports leagues/mutations,
// rosters/ownership, and players/rankings, none of which import trades
// either), so the import direction trades -> draft stays a one-way street.
// ---------------------------------------------------------------------------

/** Throws "Trades are paused while the draft is in progress." if any draft
 * in the league is still genuinely live. Resolves each IN_PROGRESS draft
 * first (same resolve-on-read principle as getFreeAgencyStatus above) — a
 * draft whose timer fully expired with nobody watching the room must not
 * keep trades paused forever just because the DB row hasn't caught up. */
export async function assertNoDraftInProgress(leagueId: string): Promise<void> {
  const inProgressDrafts = await prisma.draft.findMany({
    where: { leagueId, status: "IN_PROGRESS" },
    select: { id: true },
  });
  for (const draft of inProgressDrafts) {
    const resolved = await resolveDraftState(draft.id);
    if (resolved.status === "IN_PROGRESS") {
      throw new Error("Trades are paused while the draft is in progress.");
    }
  }
}
