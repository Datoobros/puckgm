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

export async function startNewSeason(leagueId: string, callerUserId: string): Promise<{ newSeason: number }> {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
    throw new Error("Only the league commissioner can start a new season.");
  }

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  if (settings.leagueType !== "REDRAFT") {
    throw new Error("Only a REDRAFT league resets between seasons — a DYNASTY league's rosters carry over.");
  }

  // Cancel every trade still in flight first. executeTradeTransfers silently
  // skips a missing RosterSlot, but still marks the whole Trade PROCESSED —
  // wiping rosters out from under a pending trade would leave a corrupted
  // partial record if that trade were left to resolve on its own after this.
  const pendingTrades = await prisma.trade.findMany({
    where: { leagueId, state: { in: ["PROPOSED", "UNDER_REVIEW"] } },
  });
  for (const trade of pendingTrades) {
    await cancelTrade({ tradeId: trade.id, callerUserId });
  }

  // Release every rostered player back to free agency. No pending-WaiverClaim
  // cleanup needed: demotion waivers only ever fire via sendToFarm, which is
  // unreachable at farmSlots: 0 — a REDRAFT league can never have a
  // farm-bound waiver claim in flight in the first place.
  await prisma.rosterSlot.updateMany({
    where: { team: { leagueId }, effectiveTo: null },
    data: { effectiveTo: new Date() },
  });

  const newSeason = league.currentSeason + 1;
  await prisma.league.update({ where: { id: leagueId }, data: { currentSeason: newSeason } });

  return { newSeason };
}
