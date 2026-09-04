import { prisma } from "@/lib/db";
import { createLeague, createTeam, updateLeagueSettings, deleteLeague } from "@/lib/leagues/mutations";
import { addPlayerToRoster, dropPlayerFromRoster, sendToFarm, getTeamRosterView } from "@/lib/rosters/mutations";
import { getOrInitFaabBudget, getAvailableBudget, submitFaBid } from "@/lib/faab/mutations";
import {
  proposeTrade,
  respondToTrade,
  cancelTrade,
  castTradeVeto,
  forceProcessTrade,
  processDueTrades,
} from "@/lib/trades/mutations";
import { CURRENT_SCHEDULE_SEASON } from "@/lib/matchups/constants";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function backdateReview(tradeId: string) {
  await prisma.trade.update({ where: { id: tradeId }, data: { reviewEndsAt: new Date(Date.now() - 1000) } });
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Trades Test League (delete me)",
    season: 2027,
    managerUserId: "trade-test-A",
    teamName: "Team A",
    rosterComposition: { C: 1, LW: 1, RW: 1, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "trade-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "trade-test-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  async function fixture(name: string, gp = 0) {
    return prisma.player.create({ data: { fullName: `Trade Test ${name} (delete me)`, primaryPosition: "C", careerNhlGp: gp } });
  }

  const vetPlayer = await fixture("Vet", 400);
  const declinePlayer = await fixture("Decline Bait");
  const votePlayer = await fixture("Vote Bait");
  const playerD1 = await fixture("D1");
  const playerH1 = await fixture("H1");
  const playerE1 = await fixture("E1");
  const biddable = await fixture("Biddable");

  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: vetPlayer.id, managerUserId: "trade-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: declinePlayer.id, managerUserId: "trade-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: votePlayer.id, managerUserId: "trade-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: playerD1.id, managerUserId: "trade-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: playerH1.id, managerUserId: "trade-test-A" });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: playerE1.id, managerUserId: "trade-test-A" });

  const pick1 = await prisma.draftPick.create({
    data: { leagueId, season: 2028, round: 1, originalTeamId: teamA, currentOwnerId: teamA },
  });

  console.log("\n-- propose then decline: nothing moves --");
  const { tradeId: decId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [declinePlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: decId, managerUserId: "trade-test-B", accept: false });
  const decTrade = await prisma.trade.findUniqueOrThrow({ where: { id: decId } });
  assert(decTrade.state === "DECLINED", "declined trade is terminal (DECLINED)");
  const declineStillA = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: declinePlayer.id, effectiveTo: null } });
  assert(!!declineStillA, "declined trade moved nothing — player still with Team A");

  console.log("\n-- VOTE mode: a single non-participant veto in a 3-team league is a majority --");
  await updateLeagueSettings({
    leagueId, callerUserId: "trade-test-A", farmSlots: 4, irSlots: 2, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: false, faabBudget: 100, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "VOTE", tradeDeadline: null,
  });
  const { tradeId: voteId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [votePlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: voteId, managerUserId: "trade-test-B", accept: true });
  await castTradeVeto({ tradeId: voteId, managerUserId: "trade-test-C" });
  const voteTrade = await prisma.trade.findUniqueOrThrow({ where: { id: voteId } });
  assert(voteTrade.state === "VETOED", "1 of 1 eligible voters vetoes immediately, no cron needed");

  console.log("\n-- back to COMMISSIONER veto mode for the rest --");
  await updateLeagueSettings({
    leagueId, callerUserId: "trade-test-A", farmSlots: 4, irSlots: 2, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: false, faabBudget: 100, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER", tradeDeadline: null,
  });

  console.log("\n-- full trade: player + pick + FAAB, processes cleanly --");
  const { tradeId: goodId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [vetPlayer.id], pickIds: [pick1.id], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 10 },
  });
  await respondToTrade({ tradeId: goodId, managerUserId: "trade-test-B", accept: true });
  await backdateReview(goodId);
  const dueResults1 = await processDueTrades();
  console.log("process results:", dueResults1);
  const goodTrade = await prisma.trade.findUniqueOrThrow({ where: { id: goodId } });
  assert(goodTrade.state === "PROCESSED", "trade with room on both sides processes");

  const vetSlotOnB = await prisma.rosterSlot.findFirst({ where: { teamId: teamB, playerId: vetPlayer.id, effectiveTo: null } });
  assert(!!vetSlotOnB && vetSlotOnB.slotType === "ACTIVE", "traded player lands on Team B's ACTIVE roster (his prior tier)");
  assert(!!vetSlotOnB?.tradeAcquiredAt, "tradeAcquiredAt stamped on the new slot");

  const pick1After = await prisma.draftPick.findUniqueOrThrow({ where: { id: pick1.id } });
  assert(pick1After.currentOwnerId === teamB, "pick ownership transferred to Team B");

  const budgetA = await getOrInitFaabBudget(teamA, CURRENT_SCHEDULE_SEASON, 100);
  const budgetB = await getOrInitFaabBudget(teamB, CURRENT_SCHEDULE_SEASON, 100);
  assert(budgetA.remaining === 110, "Team A's FAAB credited (100 + 10 = 110)");
  assert(budgetB.remaining === 90, "Team B's FAAB debited (100 - 10 = 90)");

  console.log("\n-- no re-exposure penalty within 24h of a trade --");
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamB, playerId: vetPlayer.id, managerUserId: "trade-test-B" });
  assert(waiverExposed === false, "sending a freshly-traded 400-GP player down doesn't re-flag waiverExposed");
  const vetFarmSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamB, playerId: vetPlayer.id, slotType: "FARM", effectiveTo: null } });
  assert(vetFarmSlot?.waiverExpiresAt === null, "no claim window opened for the exempt re-demotion");

  console.log("\n-- fill Team B's active roster to cap (8) --");
  for (let i = 0; i < 8; i++) {
    const filler = await prisma.player.create({ data: { fullName: `Trade Filler ${i} (delete me)`, primaryPosition: "C" } });
    await addPlayerToRoster({ leagueId, teamId: teamB, playerId: filler.id, managerUserId: "trade-test-B" });
  }
  const bFull = await getTeamRosterView(teamB);
  assert(bFull.filter((s) => s.slotType === "ACTIVE").length === 8, "Team B's active roster is at cap");

  console.log("\n-- room conflict: stays UNDER_REVIEW instead of failing --");
  const { tradeId: d1Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [playerD1.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: d1Id, managerUserId: "trade-test-B", accept: true });
  await backdateReview(d1Id);
  const d1Results = await processDueTrades();
  const d1Outcome = d1Results.find((r) => r.tradeId === d1Id);
  assert(d1Outcome?.outcome === "STILL_PENDING", "trade with no room on Team B stays pending, not failed");
  const d1TradeState = await prisma.trade.findUniqueOrThrow({ where: { id: d1Id } });
  assert(d1TradeState.state === "UNDER_REVIEW", "still UNDER_REVIEW, not a failure state");

  console.log("\n-- cancelTrade is the escape hatch for a stuck trade --");
  const { tradeId: h1Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [playerH1.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: h1Id, managerUserId: "trade-test-B", accept: true });
  await backdateReview(h1Id);
  await cancelTrade({ tradeId: h1Id, callerUserId: "trade-test-A" });
  const h1TradeState = await prisma.trade.findUniqueOrThrow({ where: { id: h1Id } });
  assert(h1TradeState.state === "CANCELLED", "cancelTrade cancels a stuck-pending trade");
  const h1StillA = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: playerH1.id, effectiveTo: null } });
  assert(!!h1StillA, "cancelled trade moved nothing");

  console.log("\n-- commissioner force-process bypasses the room check --");
  const { tradeId: e1Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "trade-test-A",
    give: { playerIds: [playerE1.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: e1Id, managerUserId: "trade-test-B", accept: true });
  await backdateReview(e1Id);
  await forceProcessTrade({ tradeId: e1Id, callerUserId: "trade-test-A" });
  const e1TradeState = await prisma.trade.findUniqueOrThrow({ where: { id: e1Id } });
  assert(e1TradeState.state === "PROCESSED", "force-process succeeds despite Team B being full");
  const bAfterForce = await getTeamRosterView(teamB);
  assert(bAfterForce.filter((s) => s.slotType === "ACTIVE").length === 9, "Team B's active roster overflowed to 9 (cap bypass on force-process)");

  console.log("\n-- freeing room lets the stuck trade reprocess --");
  // Team B sits at 9 (cap 8 + 1 overflow from e1's force-process) — drop 2
  // fillers so B is at 7 before d1 adds its 1 incoming player, landing
  // exactly at the cap (8) rather than over it again.
  const bRoster = await getTeamRosterView(teamB);
  const fillerSlots = bRoster.filter((s) => s.slotType === "ACTIVE" && s.player.fullName.includes("Trade Filler")).slice(0, 2);
  for (const s of fillerSlots) {
    await dropPlayerFromRoster({ teamId: teamB, playerId: s.playerId, managerUserId: "trade-test-B" });
  }
  const d1Retry = await processDueTrades();
  const d1RetryOutcome = d1Retry.find((r) => r.tradeId === d1Id);
  assert(d1RetryOutcome?.outcome === "PROCESSED", "the previously-stuck trade processes once room opens up");

  console.log("\n-- getAvailableBudget accounts for FAAB promised in a pending trade --");
  await updateLeagueSettings({
    leagueId, callerUserId: "trade-test-A", farmSlots: 4, irSlots: 2, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: true, faabBudget: 100, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER", tradeDeadline: null,
  });
  await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "trade-test-A",
    give: { playerIds: [], pickIds: [], faabAmount: 95 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  const availableAfterTradeCommit = await getAvailableBudget(teamA, CURRENT_SCHEDULE_SEASON, 100);
  assert(availableAfterTradeCommit === 15, "available budget reflects FAAB already promised away in a pending trade (110 - 95 = 15)");

  let overCommitThrew = false;
  try {
    await submitFaBid({ leagueId, playerId: biddable.id, amount: 20, targetSlot: "ACTIVE", managerUserId: "trade-test-A" });
  } catch {
    overCommitThrew = true;
  }
  assert(overCommitThrew, "a bid exceeding available budget (after the pending trade commitment) throws");
  await submitFaBid({ leagueId, playerId: biddable.id, amount: 10, targetSlot: "ACTIVE", managerUserId: "trade-test-A" });
  console.log("  ok: a bid within the remaining available budget succeeds");

  console.log("\n-- cleanup --");
  const allFixtureNames = ["Trade Test", "Trade Filler"];
  const fixturePlayers = await prisma.player.findMany({
    where: { OR: allFixtureNames.map((n) => ({ fullName: { contains: n } })) },
  });
  const fixtureIds = fixturePlayers.map((p) => p.id);
  await prisma.faBid.deleteMany({ where: { playerId: { in: fixtureIds } } });
  await deleteLeague(leagueId, "trade-test-A");
  await prisma.player.deleteMany({ where: { id: { in: fixtureIds } } });
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
