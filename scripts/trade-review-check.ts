// Regression check for the trade review/counter feature
// (src/lib/trades/mutations.ts's getTradeDetailById, and the counter-offer
// flow implemented as decline + re-propose in
// src/app/leagues/[id]/trades/actions.ts + page.tsx). The stats-fetching
// side (getPlayerStatsAggregate({ playerIds })) is pre-existing and already
// covered elsewhere — this just confirms it covers every participant ID
// pulled from a real trade's items.

import { prisma } from "@/lib/db";
import { createLeague, createTeam } from "@/lib/leagues/mutations";
import { addPlayerToRoster } from "@/lib/rosters/mutations";
import { proposeTrade, respondToTrade, getTradeDetailById } from "@/lib/trades/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Trade Review Test League (delete me)",
    season: 2031,
    managerUserId: "trade-review-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "trade-review-test-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  async function fixture(name: string) {
    return prisma.player.create({ data: { fullName: `Trade Review Test ${name} (delete me)`, primaryPosition: "C" } });
  }
  const giveMe = await fixture("Give");
  const receiveMe = await fixture("Receive");

  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: giveMe.id, managerUserId: "trade-review-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: receiveMe.id, managerUserId: "trade-review-test-B" });

  console.log("\n-- getTradeDetailById returns the right shape, incl. playerId --");
  const { tradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamB,
    managerUserId: "trade-review-test-A",
    give: { playerIds: [giveMe.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [receiveMe.id], pickIds: [], faabAmount: 0 },
  });
  const detail = await getTradeDetailById(tradeId, teamB);
  assert(!!detail, "getTradeDetailById found the trade");
  assert(detail!.proposedByTeamId === teamA && detail!.counterpartyTeamId === teamB, "correct proposer/counterparty");
  const giveItem = detail!.items.find((i) => i.fromTeamId === teamA && i.itemType === "PLAYER");
  const receiveItem = detail!.items.find((i) => i.fromTeamId === teamB && i.itemType === "PLAYER");
  assert(giveItem?.playerId === giveMe.id, "the proposer's item carries the real playerId, not just a name");
  assert(receiveItem?.playerId === receiveMe.id, "the counterparty's item carries the real playerId");

  console.log("\n-- getPlayerStatsAggregate covers every participant player ID --");
  const allPlayerIds = detail!.items.filter((i) => i.playerId).map((i) => i.playerId!);
  const stats = await getPlayerStatsAggregate({ playerIds: allPlayerIds });
  assert(stats.length === allPlayerIds.length, `stats returned for all ${allPlayerIds.length} participant players`);
  assert(stats.every((s) => !!s.fullName), "every stats row carries identity fields (fullName) for display");

  console.log("\n-- counter flow: decline + re-propose with swapped assets is a wholly separate trade --");
  await respondToTrade({ tradeId, managerUserId: "trade-review-test-B", accept: false });
  const declined = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(declined.state === "DECLINED", "original trade is DECLINED (reused respondToTrade path, same as a plain decline)");

  // Simulates what page.tsx's counterFrom handling computes: what B gave
  // becomes what B now offers to give (unchanged for this simple swap
  // case), what A gave becomes what B now wants to receive.
  const { tradeId: counterTradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamB,
    counterpartyTeamId: teamA,
    managerUserId: "trade-review-test-B",
    give: { playerIds: [receiveMe.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [giveMe.id], pickIds: [], faabAmount: 0 },
  });
  assert(counterTradeId !== tradeId, "the counter-offer is a wholly separate trade row, not a mutation of the original");
  const counterDetail = await getTradeDetailById(counterTradeId, teamA);
  assert(counterDetail!.proposedByTeamId === teamB, "the counter-offer is proposed by the original counterparty");
  assert(
    counterDetail!.items.some((i) => i.fromTeamId === teamB && i.playerId === receiveMe.id) &&
      counterDetail!.items.some((i) => i.fromTeamId === teamA && i.playerId === giveMe.id),
    "the counter-offer's assets are correctly swapped relative to the original",
  );

  const originalStillDeclined = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(originalStillDeclined.state === "DECLINED", "the original trade is untouched by the counter-offer (no linkage)");

  console.log("\nAll trade-review checks passed.");

  console.log("\n-- cleanup --");
  await prisma.tradeVeto.deleteMany({ where: { trade: { leagueId } } });
  await prisma.tradeItem.deleteMany({ where: { trade: { leagueId } } });
  await prisma.trade.deleteMany({ where: { leagueId } });
  await prisma.transactionLog.deleteMany({ where: { leagueId } });
  await prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } });
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  await prisma.player.deleteMany({ where: { id: { in: [giveMe.id, receiveMe.id] } } });
  console.log("cleaned up");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
