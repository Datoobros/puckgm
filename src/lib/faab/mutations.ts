// FAAB / "the wire" (DESIGN.md §2.7/§2.9) — blind-bid free agency, distinct
// from demotion waivers (src/lib/waivers/mutations.ts, which only ever
// applies to an already-rostered 80+ GP player someone just demoted). This
// covers picking up anyone currently unrostered.
//
// Per-league opt-in, default off (LeagueSettings.faabEnabled) — puckGM has
// no draft yet, so free instant add (addPlayerToRoster) is the only way a
// brand-new league builds a roster at all. Enabling FAAB for a league blocks
// that instant path (see the check in src/lib/rosters/mutations.ts) and
// requires a bid instead. Minimum and maximum bid are both per-league
// settings too (faabMinBid/faabMaxBid) — replacing DESIGN.md's original
// "$0 bids allowed" line, by explicit user direction.
//
// Resolution is cron-driven, piggybacked on the same daily route as
// processExpiredWaivers (Vercel Hobby's one-cron-trigger/day limit — see
// that file's header for the full reasoning). A bid has no expiry window
// like a waiver claim's 48h; it just waits for the next daily tick.

import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getOrInitWaiverPriority } from "@/lib/waivers/mutations";

export async function getOrInitFaabBudget(teamId: string, season: number, startingAmount: number) {
  const existing = await prisma.faabBudget.findUnique({ where: { teamId_season: { teamId, season } } });
  if (existing) return existing;
  return prisma.faabBudget.create({
    data: { teamId, season, startingAmount, remaining: startingAmount },
  });
}

/** The real spendable ceiling — remaining budget minus everything already
 * committed to other PENDING bids, minus FAAB promised away as the sending
 * side of any of this team's own open trades (src/lib/trades/mutations.ts —
 * a trade doesn't escrow FAAB either, so this is what stops a team
 * double-committing the same budget to a bid and a trade at once). Budget is
 * only ever debited from `remaining` at award/trade-processing time, never
 * escrowed at submission. */
export async function getAvailableBudget(teamId: string, season: number, startingAmount: number): Promise<number> {
  const budget = await getOrInitFaabBudget(teamId, season, startingAmount);
  const [pendingBids, pendingTradeFaab] = await Promise.all([
    prisma.faBid.aggregate({ where: { teamId, result: "PENDING" }, _sum: { amount: true } }),
    prisma.tradeItem.aggregate({
      where: {
        fromTeamId: teamId,
        itemType: "FAAB",
        trade: { state: { in: ["PROPOSED", "UNDER_REVIEW"] } },
      },
      _sum: { faabAmount: true },
    }),
  ]);
  return budget.remaining - (pendingBids._sum.amount ?? 0) - (pendingTradeFaab._sum.faabAmount ?? 0);
}

export interface SubmitFaBidInput {
  leagueId: string;
  playerId: string;
  amount: number;
  targetSlot: "ACTIVE" | "FARM";
  managerUserId: string;
}

export async function submitFaBid(input: SubmitFaBidInput): Promise<void> {
  const team = await prisma.team.findFirst({
    where: { leagueId: input.leagueId, managerUserId: input.managerUserId },
    include: { league: true },
  });
  if (!team) throw new Error("You don't manage a team in this league.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't submit a FAAB bid.");

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  if (!settings.faabEnabled) throw new Error("This league doesn't use FAAB.");

  if (!Number.isInteger(input.amount) || input.amount < settings.faabMinBid) {
    throw new Error(`Bid must be a whole number of at least $${settings.faabMinBid}.`);
  }
  if (settings.faabMaxBid !== null && input.amount > settings.faabMaxBid) {
    throw new Error(`Bid can't exceed this league's max of $${settings.faabMaxBid}.`);
  }

  const alreadyRostered = await prisma.rosterSlot.findFirst({
    where: { playerId: input.playerId, effectiveTo: null, team: { leagueId: input.leagueId } },
  });
  if (alreadyRostered) throw new Error("This player is already rostered.");

  const existingBid = await prisma.faBid.findFirst({
    where: { teamId: team.id, playerId: input.playerId, result: "PENDING" },
  });
  if (existingBid) throw new Error("You already have a pending bid on this player — cancel it to change the amount.");

  const available = await getAvailableBudget(team.id, team.league.currentSeason, settings.faabBudget);
  if (input.amount > available) {
    throw new Error(`Bid exceeds your available FAAB ($${available}, after your other pending bids).`);
  }

  await prisma.$transaction([
    prisma.faBid.create({
      data: {
        teamId: team.id,
        playerId: input.playerId,
        amount: input.amount,
        targetSlot: input.targetSlot,
        processDate: new Date(),
      },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "FAAB_BID",
        actorTeamId: team.id,
        payload: { playerId: input.playerId, amount: input.amount, targetSlot: input.targetSlot, event: "SUBMITTED" },
      },
    }),
  ]);
}

export interface CancelFaBidInput {
  bidId: string;
  managerUserId: string;
}

export async function cancelFaBid(input: CancelFaBidInput): Promise<void> {
  const bid = await prisma.faBid.findUnique({ where: { id: input.bidId }, include: { team: true } });
  if (!bid) throw new Error("Bid not found.");
  if (bid.team.managerUserId !== input.managerUserId) throw new Error("You don't manage this team.");
  if (bid.result !== "PENDING") throw new Error("This bid has already been resolved.");

  await prisma.faBid.delete({ where: { id: input.bidId } });
}

export async function getMyPendingBids(leagueId: string, teamId: string) {
  const bids = await prisma.faBid.findMany({
    where: { teamId, result: "PENDING", team: { leagueId } },
    include: { player: true },
    orderBy: { createdAt: "desc" },
  });
  return bids.map((b) => ({
    id: b.id,
    playerId: b.playerId,
    playerName: b.player.fullName,
    amount: b.amount,
    targetSlot: b.targetSlot,
  }));
}

export interface FaabProcessResult {
  playerId: string;
  outcome: "WON" | "VOIDED_ALREADY_ROSTERED";
  awardedToTeamId?: string;
}

/** Cron entry point. Every PENDING bid gets resolved each run — grouped by
 * player, highest amount wins, ties broken by the *current* waiver priority
 * order (the one shared "priority" concept in this app) without rotating it
 * — only a waiver-claim win does that. Award bypasses the roster cap, same
 * overflow-allowed philosophy as a waiver-claim award (see
 * src/lib/waivers/mutations.ts's processExpiredWaivers). */
export async function processFaabBids(): Promise<FaabProcessResult[]> {
  const pendingBids = await prisma.faBid.findMany({
    where: { result: "PENDING" },
    include: { team: { include: { league: true } } },
  });
  if (pendingBids.length === 0) return [];

  const byPlayer = new Map<string, typeof pendingBids>();
  for (const bid of pendingBids) {
    const list = byPlayer.get(bid.playerId) ?? [];
    list.push(bid);
    byPlayer.set(bid.playerId, list);
  }

  const results: FaabProcessResult[] = [];

  for (const [playerId, bids] of byPlayer) {
    const stillUnrostered = !(await prisma.rosterSlot.findFirst({
      where: { playerId, effectiveTo: null, team: { leagueId: bids[0].team.leagueId } },
    }));
    if (!stillUnrostered) {
      await prisma.faBid.updateMany({ where: { id: { in: bids.map((b) => b.id) } }, data: { result: "LOST" } });
      results.push({ playerId, outcome: "VOIDED_ALREADY_ROSTERED" });
      continue;
    }

    // A team frozen (ORPHAN_FROZEN) after bidding but before this runs must
    // not still win — filtered out of eligibility, resolved as LOST below.
    const eligible = bids.filter((b) => b.team.state === "ACTIVE");
    if (eligible.length === 0) {
      await prisma.faBid.updateMany({ where: { id: { in: bids.map((b) => b.id) } }, data: { result: "LOST" } });
      continue;
    }

    const leagueId = bids[0].team.leagueId;
    const priority = await getOrInitWaiverPriority(leagueId);
    const rank = (teamId: string) => {
      const idx = priority.indexOf(teamId);
      return idx === -1 ? priority.length : idx;
    };
    const winner = eligible.reduce((best, b) => {
      if (b.amount > best.amount) return b;
      if (b.amount === best.amount && rank(b.teamId) < rank(best.teamId)) return b;
      return best;
    });
    const losers = bids.filter((b) => b.id !== winner.id);

    const settings = winner.team.league.settingsJson as unknown as LeagueSettings;
    const budget = await getOrInitFaabBudget(winner.teamId, winner.team.league.currentSeason, settings.faabBudget);
    // Safety net — remaining shouldn't drift below what was checked at
    // submission, but re-verify before debiting rather than trusting it.
    if (winner.amount > budget.remaining) {
      await prisma.faBid.updateMany({ where: { id: { in: bids.map((b) => b.id) } }, data: { result: "LOST" } });
      continue;
    }

    await prisma.$transaction([
      prisma.faabBudget.update({ where: { id: budget.id }, data: { remaining: budget.remaining - winner.amount } }),
      prisma.rosterSlot.create({
        data: { teamId: winner.teamId, playerId, slotType: winner.targetSlot },
      }),
      prisma.faBid.update({ where: { id: winner.id }, data: { result: "WON" } }),
      ...(losers.length > 0
        ? [prisma.faBid.updateMany({ where: { id: { in: losers.map((b) => b.id) } }, data: { result: "LOST" } })]
        : []),
      prisma.transactionLog.create({
        data: {
          leagueId,
          type: "FAAB_WIN",
          actorTeamId: winner.teamId,
          payload: { playerId, amount: winner.amount, targetSlot: winner.targetSlot },
        },
      }),
    ]);

    results.push({ playerId, outcome: "WON", awardedToTeamId: winner.teamId });
  }

  return results;
}
