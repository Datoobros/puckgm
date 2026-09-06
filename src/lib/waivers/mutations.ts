// Demotion waivers (DESIGN.md §2.3/§2.9) — distinct from "the wire" (FAAB
// pickups of unowned players, still unbuilt). sendToFarm (src/lib/rosters/
// mutations.ts) already flags a demoted 80+ GP player as waiverExposed and
// sets RosterSlot.waiverExpiresAt; this file is what actually lets another
// team claim him and what resolves that claim once the window passes.
//
// Priority is a rotating queue, NOT "reverse standings, updated weekly" as
// DESIGN.md §2.3 originally specified — overridden by explicit user
// direction, since puckGM has no draft feature yet to seed a real draft
// order from, and no season data yet to compute real standings from either.
// Seeded once per league as reverse team-creation order (a documented
// placeholder for the seed only — the rotation itself, "a successful
// claimant falls to the back," is the permanent mechanic going forward, not
// a fallback to be replaced later).
//
// Claim window: 48 hours, enforced only by RosterSlot.waiverExpiresAt.
// Resolution happens once daily, piggybacked on the existing ingest cron
// (src/app/api/cron/daily-ingest/route.ts) — Vercel's Hobby plan allows only
// one cron trigger per project per day, so "48 hours" in practice means "at
// the next daily tick after 48 hours have elapsed," up to ~24h of slop.

import { prisma } from "@/lib/db";
import { isTeamManager, managerOrCoManagerWhere } from "@/lib/leagues/mutations";

const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function getOrInitWaiverPriority(leagueId: string): Promise<string[]> {
  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  if (league.waiverPriorityJson) {
    return league.waiverPriorityJson as unknown as string[];
  }

  const teams = await prisma.team.findMany({
    where: { leagueId },
    orderBy: { createdAt: "desc" }, // reverse team-creation order — last created picks first
    select: { id: true },
  });
  const order = teams.map((t) => t.id);
  await prisma.league.update({
    where: { id: leagueId },
    data: { waiverPriorityJson: order },
  });
  return order;
}

/** Moves teamId to the back of the queue (it just won a claim). Teams not
 * yet in the stored order (created after it was seeded) are appended ahead
 * of this rotation so they still get a turn. */
async function rotatePriorityToBack(leagueId: string, teamId: string): Promise<void> {
  const current = await getOrInitWaiverPriority(leagueId);
  const next = [...current.filter((id) => id !== teamId), teamId];
  await prisma.league.update({ where: { id: leagueId }, data: { waiverPriorityJson: next } });
}

export interface ClaimablePlayer {
  rosterSlotId: string;
  playerId: string;
  playerName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
  demotingTeamId: string;
  demotingTeamName: string;
  waiverExpiresAt: Date;
  myPendingClaimId: string | null;
}

/** Every player currently sitting in a waiver window, league-wide, plus
 * whether `viewingTeamId` already has a pending claim on each. */
export async function getClaimablePlayers(leagueId: string, viewingTeamId: string | null): Promise<ClaimablePlayer[]> {
  const now = new Date();
  const slots = await prisma.rosterSlot.findMany({
    where: {
      slotType: "FARM",
      effectiveTo: null,
      waiverExpiresAt: { gt: now },
      team: { leagueId },
    },
    include: { player: true, team: true },
    orderBy: { waiverExpiresAt: "asc" },
  });
  if (slots.length === 0) return [];

  const pendingClaims = viewingTeamId
    ? await prisma.waiverClaim.findMany({
        where: {
          teamId: viewingTeamId,
          result: "PENDING",
          playerId: { in: slots.map((s) => s.playerId) },
        },
      })
    : [];
  const myClaimByPlayer = new Map(pendingClaims.map((c) => [c.playerId, c.id]));

  return slots.map((s) => ({
    rosterSlotId: s.id,
    playerId: s.playerId,
    playerName: s.player.fullName,
    primaryPosition: s.player.primaryPosition,
    currentNhlOrg: s.player.currentNhlOrg,
    demotingTeamId: s.teamId,
    demotingTeamName: s.team.name,
    waiverExpiresAt: s.waiverExpiresAt!,
    myPendingClaimId: myClaimByPlayer.get(s.playerId) ?? null,
  }));
}

export interface SubmitWaiverClaimInput {
  leagueId: string;
  playerId: string;
  managerUserId: string;
}

export async function submitWaiverClaim(input: SubmitWaiverClaimInput): Promise<void> {
  const claimingTeam = await prisma.team.findFirst({
    where: { leagueId: input.leagueId, ...managerOrCoManagerWhere(input.managerUserId) },
  });
  if (!claimingTeam) throw new Error("You don't manage a team in this league.");
  if (claimingTeam.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't submit a waiver claim.");

  const slot = await prisma.rosterSlot.findFirst({
    where: {
      playerId: input.playerId,
      slotType: "FARM",
      effectiveTo: null,
      waiverExpiresAt: { gt: new Date() },
      team: { leagueId: input.leagueId },
    },
    include: { player: true },
  });
  if (!slot) throw new Error("This player isn't currently on waivers.");
  if (slot.teamId === claimingTeam.id) throw new Error("You can't claim a player you just demoted.");

  const existing = await prisma.waiverClaim.findFirst({
    where: { teamId: claimingTeam.id, playerId: input.playerId, result: "PENDING" },
  });
  if (existing) throw new Error("You already have a pending claim on this player.");

  const priority = await getOrInitWaiverPriority(input.leagueId);
  const priorityAtClaim = priority.indexOf(claimingTeam.id);

  await prisma.$transaction([
    prisma.waiverClaim.create({
      data: {
        teamId: claimingTeam.id,
        playerId: input.playerId,
        priorityAtClaim: priorityAtClaim === -1 ? priority.length : priorityAtClaim,
      },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "WAIVER_CLAIM",
        actorTeamId: claimingTeam.id,
        payload: { playerId: input.playerId, event: "SUBMITTED" },
      },
    }),
  ]);
}

export interface CancelWaiverClaimInput {
  claimId: string;
  managerUserId: string;
}

export async function cancelWaiverClaim(input: CancelWaiverClaimInput): Promise<void> {
  const claim = await prisma.waiverClaim.findUnique({ where: { id: input.claimId }, include: { team: true } });
  if (!claim) throw new Error("Claim not found.");
  if (!isTeamManager(claim.team, input.managerUserId)) throw new Error("You don't manage this team.");
  if (claim.result !== "PENDING") throw new Error("This claim has already been resolved.");

  await prisma.waiverClaim.delete({ where: { id: input.claimId } });
}

/** Voids any PENDING claims on a player who's no longer sitting in a waiver
 * window — e.g. his original team called him back up before the window
 * expired. Called from callUpToActive; safe to call even when no claims
 * exist. */
export async function voidPendingClaimsForPlayer(playerId: string): Promise<void> {
  await prisma.waiverClaim.updateMany({
    where: { playerId, result: "PENDING" },
    data: { result: "CLEARED" },
  });
}

export interface ProcessResult {
  playerId: string;
  outcome: "AWARDED" | "CLEARED" | "EXPIRED_UNCLAIMED";
  awardedToTeamId?: string;
}

/** Cron entry point. Resolves every FARM slot whose waiver window has
 * passed: awards to the highest-current-priority pending claimant (if any),
 * clears the rest, rotates the queue, and lands the player on the winner's
 * ACTIVE roster even if that roster is already at cap — DESIGN.md's roster
 * cap is enforced everywhere else (addPlayerToRoster, callUpToActive,
 * activateFromIR) but deliberately not here, matching the un-auto-enforced
 * IR-48h-deadline pattern: the constraint is real but nothing forces a
 * corresponding drop on a timer. Processed oldest-expiry-first so priority
 * rotations from an earlier award in the same run are visible to later ones. */
export async function processExpiredWaivers(): Promise<ProcessResult[]> {
  const now = new Date();
  const expiredSlots = await prisma.rosterSlot.findMany({
    where: { slotType: "FARM", effectiveTo: null, waiverExpiresAt: { lte: now } },
    include: { team: true },
    orderBy: { waiverExpiresAt: "asc" },
  });

  const results: ProcessResult[] = [];

  for (const slot of expiredSlots) {
    const pending = await prisma.waiverClaim.findMany({
      where: { playerId: slot.playerId, result: "PENDING" },
      include: { team: true },
    });
    // A team frozen (ORPHAN_FROZEN) after submitting but before this runs
    // must not still win — filtered out of eligibility, but still resolved
    // (as a loser, below) rather than left PENDING forever.
    const eligible = pending.filter((c) => c.team.state === "ACTIVE");

    if (eligible.length === 0) {
      await prisma.$transaction([
        prisma.rosterSlot.update({ where: { id: slot.id }, data: { waiverExpiresAt: null } }),
        ...(pending.length > 0
          ? [prisma.waiverClaim.updateMany({ where: { id: { in: pending.map((c) => c.id) } }, data: { result: "CLEARED" } })]
          : []),
      ]);
      results.push({ playerId: slot.playerId, outcome: "EXPIRED_UNCLAIMED" });
      continue;
    }

    const priority = await getOrInitWaiverPriority(slot.team.leagueId);
    const rank = (teamId: string) => {
      const idx = priority.indexOf(teamId);
      return idx === -1 ? priority.length : idx;
    };
    const winner = eligible.reduce((best, c) => (rank(c.teamId) < rank(best.teamId) ? c : best));
    const losers = pending.filter((c) => c.id !== winner.id);

    await prisma.$transaction([
      prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: now } }),
      prisma.rosterSlot.create({
        data: { teamId: winner.teamId, playerId: slot.playerId, slotType: "ACTIVE", waiverClaimedAt: now },
      }),
      prisma.waiverClaim.update({ where: { id: winner.id }, data: { result: "AWARDED" } }),
      ...(losers.length > 0
        ? [prisma.waiverClaim.updateMany({ where: { id: { in: losers.map((c) => c.id) } }, data: { result: "CLEARED" } })]
        : []),
      prisma.transactionLog.create({
        data: {
          leagueId: slot.team.leagueId,
          type: "WAIVER_CLAIM",
          actorTeamId: winner.teamId,
          payload: { playerId: slot.playerId, event: "AWARDED", fromTeamId: slot.teamId },
        },
      }),
    ]);
    await rotatePriorityToBack(slot.team.leagueId, winner.teamId);

    results.push({ playerId: slot.playerId, outcome: "AWARDED", awardedToTeamId: winner.teamId });
  }

  return results;
}
