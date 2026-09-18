// Season rollover — REDRAFT leagues only. DYNASTY leagues never call this;
// their rosters persist indefinitely and nothing here ever runs for them.
//
// A separate file from src/lib/leagues/mutations.ts specifically to avoid a
// circular import: trades/mutations.ts already imports from leagues/
// mutations.ts, so calling cancelTrade() from inside mutations.ts itself
// would create a cycle. This file depends on both and is depended on by
// neither.

import { prisma } from "@/lib/db";
import { isLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { cancelTrade } from "@/lib/trades/mutations";

export interface WipeLeagueRostersOptions {
  // Scopes the roster-slot close and the LineupEntry delete to just these
  // players (LM Tools batch Task 9's ROOKIE reset — only the drafted
  // players come off rosters, everyone else on the team is untouched).
  // Omitted = every open slot/entry in the league, the original
  // startNewSeason behavior.
  onlyPlayerIds?: string[];
  // "YYYY-MM-DD" (todayUTC() shape) — when set, only LineupEntry rows on or
  // after this date are deleted. Omitted deletes every LineupEntry row for
  // the affected teams, matching startNewSeason's original behavior (a
  // redraft's rollover has no "history to preserve" concept the way a
  // mid-season draft reset does).
  lineupEntriesFrom?: string;
}

export interface WipeLeagueRostersResult {
  cancelledTrades: number;
  closedSlots: number;
  deletedLineupEntries: number;
}

/** Cancels every trade still in flight, closes open RosterSlot rows, and
 * deletes now-stale LineupEntry rows. Shared by startNewSeason (a full,
 * league-wide wipe) and resetDraft (src/lib/draft/reset.ts — sometimes
 * scoped to just the drafted players via onlyPlayerIds). */
export async function wipeLeagueRosters(
  leagueId: string,
  callerUserId: string,
  opts: WipeLeagueRostersOptions = {},
): Promise<WipeLeagueRostersResult> {
  // Cancel every trade still in flight first. executeTradeTransfers silently
  // skips a missing RosterSlot, but still marks the whole Trade PROCESSED —
  // wiping rosters out from under a pending trade would leave a corrupted
  // partial record if that trade were left to resolve on its own after this.
  const pendingTrades = await prisma.trade.findMany({
    where: { leagueId, state: { in: ["PROPOSED", "UNDER_REVIEW"] } },
  });
  for (const trade of pendingTrades) {
    await cancelTrade({ tradeId: trade.id, callerUserId, allowUnderReview: true });
  }

  const playerFilter = opts.onlyPlayerIds ? { playerId: { in: opts.onlyPlayerIds } } : {};

  const { count: closedSlots } = await prisma.rosterSlot.updateMany({
    where: { team: { leagueId }, effectiveTo: null, ...playerFilter },
    data: { effectiveTo: new Date() },
  });

  const { count: deletedLineupEntries } = await prisma.lineupEntry.deleteMany({
    where: {
      team: { leagueId },
      ...playerFilter,
      ...(opts.lineupEntriesFrom ? { gameDate: { gte: new Date(`${opts.lineupEntriesFrom}T00:00:00.000Z`) } } : {}),
    },
  });

  return { cancelledTrades: pendingTrades.length, closedSlots, deletedLineupEntries };
}

export async function startNewSeason(leagueId: string, callerUserId: string): Promise<{ newSeason: number }> {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
    throw new Error("Only the league commissioner can start a new season.");
  }

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  if (settings.leagueType !== "REDRAFT") {
    throw new Error("Only a REDRAFT league resets between seasons — a DYNASTY league's rosters carry over.");
  }

  // No pending-WaiverClaim cleanup needed: demotion waivers only ever fire
  // via sendToFarm, which is unreachable at farmSlots: 0 — a REDRAFT league
  // can never have a farm-bound waiver claim in flight in the first place.
  await wipeLeagueRosters(leagueId, callerUserId);

  const newSeason = league.currentSeason + 1;
  await prisma.league.update({ where: { id: leagueId }, data: { currentSeason: newSeason } });

  return { newSeason };
}
