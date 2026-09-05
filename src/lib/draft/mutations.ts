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
import { getLeagueCommissioner } from "@/lib/leagues/mutations";
import { getLeagueOwnershipMap } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";

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
  const commissioner = await getLeagueCommissioner(input.leagueId);
  if (!commissioner || commissioner !== input.callerUserId) {
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

export async function startDraft(input: { draftId: string; callerUserId: string }): Promise<void> {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  const commissioner = await getLeagueCommissioner(draft.leagueId);
  if (!commissioner || commissioner !== input.callerUserId) {
    throw new Error("Only the league commissioner can start the draft.");
  }
  if (draft.status !== "SETUP") throw new Error("This draft has already started.");

  await prisma.draft.update({
    where: { id: input.draftId },
    data: { status: "IN_PROGRESS", currentPickDeadline: new Date(Date.now() + draft.pickTimerSeconds * 1000) },
  });
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

/** Already sorted by autopick priority — pool[0] is what autopick takes. */
export async function getDraftPool(draft: { leagueId: string; type: "STARTUP" | "ROOKIE"; season: number }): Promise<DraftPoolPlayer[]> {
  if (draft.type === "STARTUP") {
    const rows = await getPlayerStatsAggregate(); // full pool, pre-sorted desc by career points
    const ownership = await getLeagueOwnershipMap(draft.leagueId, rows.map((r) => r.id));
    return rows
      .filter((r) => !ownership.has(r.id))
      .map((r) => ({ id: r.id, fullName: r.fullName, primaryPosition: r.primaryPosition, currentNhlOrg: r.currentNhlOrg }));
  }

  const prospects = await prisma.player.findMany({
    where: { draftYear: draft.season },
    orderBy: { draftOverallPick: "asc" },
  });
  const ownership = await getLeagueOwnershipMap(draft.leagueId, prospects.map((p) => p.id));
  return prospects
    .filter((p) => !ownership.has(p.id))
    .map((p) => ({ id: p.id, fullName: p.fullName, primaryPosition: p.primaryPosition, currentNhlOrg: p.currentNhlOrg }));
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

async function recordPick(draft: DraftRow, pick: PendingPick, playerId: string, autopicked: boolean): Promise<void> {
  await prisma.$transaction([
    prisma.rosterSlot.create({ data: { teamId: pick.currentOwnerId, playerId, slotType: "ACTIVE" } }),
    prisma.draftPick.update({ where: { id: pick.id }, data: { usedOnPlayerId: playerId } }),
    prisma.transactionLog.create({
      data: {
        leagueId: draft.leagueId,
        type: "DRAFT_PICK",
        actorTeamId: pick.currentOwnerId,
        payload: { playerId, round: pick.round, overallPick: pick.overallPick, autopicked },
      },
    }),
  ]);
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
  currentPick: { round: number; overallPick: number; teamId: string; teamName: string; msRemaining: number } | null;
  recentPicks: { round: number; overallPick: number; teamName: string; playerName: string; autopicked: boolean }[];
  pool: DraftPoolPlayer[];
}

async function buildView(draft: DraftRow): Promise<DraftStateView> {
  const current = draft.status === "IN_PROGRESS" ? await getCurrentPick(draft.id) : null;
  const pool = draft.status === "IN_PROGRESS" ? await getDraftPool(draft) : [];
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
 * first. Loops so a stretch nobody was watching (or a slow network) still
 * catches all the way up to the true current state in one call. */
export async function resolveDraftState(draftId: string): Promise<DraftStateView> {
  for (let i = 0; i < 1000; i++) {
    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    if (draft.status !== "IN_PROGRESS") return buildView(draft);

    const current = await getCurrentPick(draftId);
    if (!current) {
      await prisma.draft.update({ where: { id: draftId }, data: { status: "COMPLETE", currentPickDeadline: null } });
      continue;
    }
    if (!draft.currentPickDeadline || draft.currentPickDeadline > new Date()) {
      return buildView(draft);
    }

    const pool = await getDraftPool(draft);
    const top = pool[0];
    if (!top) throw new Error("No players left in the draft pool to autopick.");
    await recordPick(draft, current, top.id, true);
    await advanceDeadline(draft, draft.currentPickDeadline);
  }
  throw new Error("Draft state failed to settle — this points to a real bug, not normal load.");
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
  if (current.currentOwner.managerUserId !== input.managerUserId) {
    throw new Error("It's not your turn.");
  }

  const pool = await getDraftPool(draft);
  if (!pool.some((p) => p.id === input.playerId)) {
    throw new Error("That player isn't available.");
  }

  await recordPick(draft, current, input.playerId, false);
  await advanceDeadline(draft);
}
