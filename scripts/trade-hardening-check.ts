// Verifies Task 1b of plans/trades-batch.md (trade hardening — a loophole
// audit of Task 1's trade integrity pass). Disposable league, cleaned up by
// exact name at the end (shared prod DB — see PROGRESS.md). Rosters via
// commissionerAddPlayer throughout, same as trade-integrity-check.ts. Small
// active cap (3) so overflow is trivial to hit on purpose for the
// stuck-trade test.
//
// Covers, in a different order than the plan's numbered list (grouped so
// the league's FAAB setting only has to flip on once, and so the roster-cap
// stress test runs before other tests add players that would make its
// arithmetic ambiguous) — each section is labelled with its plan number:
//   1. Pick locking + used-pick exclusion (getTradeableAssets, proposeTrade)
//   2. Silent half-trade -> INVALIDATED (executeTradeTransfers)
//   8. FAAB off -> availableFaab 0, FAAB item rejected
//   3. FAAB freeze-by-proposal fix (getAvailableBudget)
//   4. Trade deadline re-checked at accept time
//   6. 3-day stuck-trade auto-cancel (processDueTrades) + notifications
//   7. Same-instant double-accept race guard
//   5. Full trade freeze during a live draft
//   9. Orphaning a team cancels its in-flight trades
//
// Note: gap #9's fix lives in the Server Action layer (orphanTeamAction,
// src/app/leagues/actions.ts) rather than a lib function, because a
// Server Action calling Clerk's auth.protect() can't run under plain tsx
// (the same pre-existing limitation documented for scripts/roster-action-
// check.ts). Section 9 below replicates the action's exact sequence
// (cancel in-flight trades, then setTeamManager orphan) by calling the
// same underlying lib functions the action calls, in the same order.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, updateLeagueSettings, setTeamManager } from "@/lib/leagues/mutations";
import { commissionerAddPlayer } from "@/lib/rosters/mutations";
import { proposeTrade, respondToTrade, processDueTrades, getTradeableAssets, cancelTrade } from "@/lib/trades/mutations";
import { getAvailableBudget } from "@/lib/faab/mutations";
import { setUpDraft, startDraft, makeDraftPick, resolveDraftState } from "@/lib/draft/mutations";
import { getTeamNotifications } from "@/lib/notifications/feed";

const LEAGUE_SEASON = 2033;
const ACTIVE_CAP = 3; // C:1, LW:1, RW:1 — matches trade-integrity-check.ts's small-cap pattern
const FAAB_BUDGET = 100;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function assertThrows(fn: () => Promise<unknown>, label: string, substring: string) {
  try {
    await fn();
    assert(false, `${label} throws`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes(substring), `${label} throws containing "${substring}" (got: "${msg}")`);
  }
}

async function backdate(tradeId: string, msAgo: number) {
  await prisma.trade.update({ where: { id: tradeId }, data: { reviewEndsAt: new Date(Date.now() - msAgo) } });
}

async function activeCount(teamId: string): Promise<number> {
  return prisma.rosterSlot.count({ where: { teamId, slotType: "ACTIVE", effectiveTo: null } });
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Trade Hardening Test League (delete me)",
    season: LEAGUE_SEASON,
    managerUserId: "hardening-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 1,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "hardening-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "hardening-test-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  let fixtureCounter = 0;
  async function fixture(name: string) {
    fixtureCounter++;
    return prisma.player.create({ data: { fullName: `Trade Hardening Test ${name} (delete me)`, primaryPosition: "C" } });
  }

  // ===========================================================================
  console.log("\n== 1. Pick locking + used-pick exclusion ==");
  // ===========================================================================
  const pickP = await prisma.draftPick.create({
    data: { leagueId, season: 2040, round: 1, originalTeamId: teamA, currentOwnerId: teamA },
  });
  const usedPickDummyPlayer = await fixture("UsedPickDummy");
  const pickUsed = await prisma.draftPick.create({
    data: { leagueId, season: 2040, round: 2, originalTeamId: teamA, currentOwnerId: teamA, usedOnPlayerId: usedPickDummyPlayer.id },
  });

  const assetsABefore = await getTradeableAssets(teamA);
  assert(!assetsABefore.picks.some((p) => p.id === pickUsed.id), "a used pick is absent from getTradeableAssets");
  assert(assetsABefore.picks.some((p) => p.id === pickP.id), "the unused pick is present in getTradeableAssets");

  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "hardening-test-A",
      give: { playerIds: [], pickIds: [pickUsed.id], faabAmount: 0 },
      receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade offering a used pick",
    "owned (and unused)",
  );

  const { tradeId: t1Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "hardening-test-A",
    give: { playerIds: [], pickIds: [pickP.id], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: t1Id, managerUserId: "hardening-test-B", accept: true });
  const t1State = await prisma.trade.findUniqueOrThrow({ where: { id: t1Id } });
  assert(t1State.state === "UNDER_REVIEW", "T1 (pick-only trade) accepted -> UNDER_REVIEW, pickP now locked");

  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "hardening-test-A",
      give: { playerIds: [], pickIds: [pickP.id], faabAmount: 0 },
      receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade including pickP (locked by T1)",
    "locked in a pending trade",
  );

  // ===========================================================================
  console.log("\n== 2. Silent half-trade -> INVALIDATED (reuses T1/pickP) ==");
  // ===========================================================================
  await backdate(t1Id, 1000);
  // Simulate the gap: a commissioner (or any other path) moves pickP's
  // ownership directly, bypassing the trade flow entirely, while T1 is still
  // UNDER_REVIEW and about to process.
  await prisma.draftPick.update({ where: { id: pickP.id }, data: { currentOwnerId: teamC } });

  const dueResults2 = await processDueTrades();
  assert(
    dueResults2.some((r) => r.tradeId === t1Id && r.outcome === "INVALIDATED"),
    "processDueTrades reports T1 as INVALIDATED",
  );
  const t1After = await prisma.trade.findUniqueOrThrow({ where: { id: t1Id } });
  assert(t1After.state === "CANCELLED", "T1 is CANCELLED after invalidation, not silently PROCESSED with a missing item");

  const invalidatedLog = await prisma.transactionLog.findFirst({
    where: {
      leagueId, type: "TRADE",
      AND: [{ payload: { path: ["tradeId"], equals: t1Id } }, { payload: { path: ["event"], equals: "INVALIDATED" } }],
    },
  });
  assert(!!invalidatedLog, "an INVALIDATED log row exists for T1");
  const invalidatedReason = (invalidatedLog!.payload as { reason?: string }).reason ?? "";
  assert(invalidatedReason.includes("2040") && invalidatedReason.includes("Round 1"), `the INVALIDATED reason names the pick (got: "${invalidatedReason}")`);

  const pickPAfter = await prisma.draftPick.findUniqueOrThrow({ where: { id: pickP.id } });
  assert(pickPAfter.currentOwnerId === teamC, "pickP's ownership is untouched by the cancelled trade (nothing moved)");

  // ===========================================================================
  console.log("\n== 8. FAAB off -> availableFaab 0, FAAB item rejected ==");
  // ===========================================================================
  const assetsABeforeFaab = await getTradeableAssets(teamA);
  assert(assetsABeforeFaab.availableFaab === 0, "availableFaab is 0 while this league's FAAB is off (the default)");
  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "hardening-test-A",
      give: { playerIds: [], pickIds: [], faabAmount: 10 },
      receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade offering FAAB while the league's FAAB is off",
    "doesn't use FAAB",
  );

  console.log("\n(enabling FAAB for the rest of the script)");
  await updateLeagueSettings({
    leagueId, callerUserId: "hardening-test-A", farmSlots: 1, irSlots: 1, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: true, faabBudget: FAAB_BUDGET, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER", tradeDeadline: null,
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    draftPickTradingEnabled: true,
  });

  // ===========================================================================
  console.log("\n== 3. FAAB freeze-by-proposal fix ==");
  // ===========================================================================
  const availBeforeAsk = await getAvailableBudget(teamA, LEAGUE_SEASON, FAAB_BUDGET);
  assert(availBeforeAsk === FAAB_BUDGET, "my (A's) available FAAB starts at the full budget");

  const { tradeId: t3Id } = await proposeTrade({
    leagueId, proposingTeamId: teamB, counterpartyTeamId: teamA, managerUserId: "hardening-test-B",
    give: { playerIds: [], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 50 }, // B is asking to receive $50 of A's FAAB
  });
  const availAfterAsk = await getAvailableBudget(teamA, LEAGUE_SEASON, FAAB_BUDGET);
  assert(availAfterAsk === FAAB_BUDGET, "my (A's) available FAAB is UNCHANGED by a rival's still-PROPOSED ask — not frozen until I agree");

  await respondToTrade({ tradeId: t3Id, managerUserId: "hardening-test-A", accept: true });
  const availAfterAccept = await getAvailableBudget(teamA, LEAGUE_SEASON, FAAB_BUDGET);
  assert(availAfterAccept === FAAB_BUDGET - 50, "my (A's) available FAAB drops by $50 the moment I accept (UNDER_REVIEW)");

  // ===========================================================================
  console.log("\n== 4. Trade deadline re-checked at accept time ==");
  // ===========================================================================
  const deadlineTestPlayer = await fixture("DeadlineTest");
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: deadlineTestPlayer.id, callerUserId: "hardening-test-A" });
  const { tradeId: t4Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "hardening-test-A",
    give: { playerIds: [deadlineTestPlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await updateLeagueSettings({
    leagueId, callerUserId: "hardening-test-A", farmSlots: 1, irSlots: 1, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: true, faabBudget: FAAB_BUDGET, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER", tradeDeadline: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    draftPickTradingEnabled: true,
  });
  await assertThrows(
    () => respondToTrade({ tradeId: t4Id, managerUserId: "hardening-test-C", accept: true }),
    "respondToTrade accept after the deadline (proposed before it) has passed",
    "trade deadline has passed",
  );
  // Reset the deadline so it doesn't block any later accept in this script.
  await updateLeagueSettings({
    leagueId, callerUserId: "hardening-test-A", farmSlots: 1, irSlots: 1, waiverGpThreshold: 80, callupsPerWeek: 2,
    scoringConfig: {}, faabEnabled: true, faabBudget: FAAB_BUDGET, faabMinBid: 1, faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER", tradeDeadline: null,
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    draftPickTradingEnabled: true,
  });

  // ===========================================================================
  console.log("\n== 6. 3-day stuck-trade auto-cancel + notifications ==");
  // ===========================================================================
  const stuckGiveMe = await fixture("StuckGiveMe");
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: stuckGiveMe.id, callerUserId: "hardening-test-A" });
  const { tradeId: t6Id } = await proposeTrade({
    leagueId, proposingTeamId: teamC, counterpartyTeamId: teamA, managerUserId: "hardening-test-C",
    give: { playerIds: [stuckGiveMe.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: t6Id, managerUserId: "hardening-test-A", accept: true }); // fits: A has room right now
  const t6AfterAccept = await prisma.trade.findUniqueOrThrow({ where: { id: t6Id } });
  assert(t6AfterAccept.state === "UNDER_REVIEW", "T6 accepted while Team A still had room");

  // Drift: Team A independently fills up to the active cap (e.g. a
  // commissioner override, in reality could be other adds) — the pending
  // incoming player from T6 would now push it over.
  let fillerIdx = 0;
  while ((await activeCount(teamA)) < ACTIVE_CAP) {
    const filler = await fixture(`StuckFiller${fillerIdx++}`);
    await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: filler.id, callerUserId: "hardening-test-A" });
  }
  assert((await activeCount(teamA)) === ACTIVE_CAP, "Team A is now at its active cap independent of T6's still-pending incoming player");

  await backdate(t6Id, 4 * 24 * 60 * 60 * 1000); // 4 days ago — past the 3-day stuck-trade grace period
  const dueResults6 = await processDueTrades();
  const t6Final = await prisma.trade.findUniqueOrThrow({ where: { id: t6Id } });
  assert(t6Final.state === "CANCELLED", "T6 auto-cancelled after 3+ days stuck on roster room");
  assert(
    dueResults6.some((r) => r.tradeId === t6Id && r.outcome === "AUTO_CANCELLED"),
    "processDueTrades reports T6 as AUTO_CANCELLED",
  );
  const autoCancelledLog = await prisma.transactionLog.findFirst({
    where: {
      leagueId, type: "TRADE",
      AND: [{ payload: { path: ["tradeId"], equals: t6Id } }, { payload: { path: ["event"], equals: "AUTO_CANCELLED" } }],
    },
  });
  assert(!!autoCancelledLog, "an AUTO_CANCELLED log row exists for T6");
  const blockingTeamIds = (autoCancelledLog!.payload as { blockingTeamIds?: string[] }).blockingTeamIds ?? [];
  assert(blockingTeamIds.includes(teamA), `AUTO_CANCELLED log names Team A as blocking (got: ${JSON.stringify(blockingTeamIds)})`);

  const notificationsA6 = await getTeamNotifications(leagueId, teamA);
  assert(
    notificationsA6.some((n) => n.kind === "TRADE_RESULT" && n.text.includes("cancelled") && n.text.includes("stuck on roster room")),
    "Team A (blocking side) gets a TRADE_RESULT notification about the auto-cancellation",
  );
  const notificationsC6 = await getTeamNotifications(leagueId, teamC);
  assert(
    notificationsC6.some((n) => n.kind === "TRADE_RESULT" && n.text.includes("cancelled") && n.text.includes("stuck on roster room")),
    "Team C (the other party) also gets a TRADE_RESULT notification — both sides are told",
  );

  // ===========================================================================
  console.log("\n== 7. Same-instant double-accept race guard ==");
  // ===========================================================================
  const raceTest = await fixture("RaceTest");
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: raceTest.id, callerUserId: "hardening-test-A" });
  const { tradeId: t7Id } = await proposeTrade({
    leagueId, proposingTeamId: teamB, counterpartyTeamId: teamC, managerUserId: "hardening-test-B",
    give: { playerIds: [raceTest.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  const [r1, r2] = await Promise.allSettled([
    respondToTrade({ tradeId: t7Id, managerUserId: "hardening-test-C", accept: true }),
    respondToTrade({ tradeId: t7Id, managerUserId: "hardening-test-C", accept: true }),
  ]);
  const fulfilledCount = [r1, r2].filter((r) => r.status === "fulfilled").length;
  const rejected = [r1, r2].find((r): r is PromiseRejectedResult => r.status === "rejected");
  assert(fulfilledCount === 1, `exactly one of the two concurrent accept calls fulfilled (got ${fulfilledCount})`);
  assert(
    !!rejected && String((rejected.reason as Error).message).includes("already answered"),
    `the other concurrent call rejected with "already answered" (got: ${rejected ? (rejected.reason as Error).message : "none rejected"})`,
  );
  const t7Final = await prisma.trade.findUniqueOrThrow({ where: { id: t7Id } });
  assert(t7Final.state === "UNDER_REVIEW", "T7 flipped to UNDER_REVIEW exactly once, not corrupted by the race");
  const acceptedLogs7 = await prisma.transactionLog.findMany({
    where: {
      leagueId, type: "TRADE",
      AND: [{ payload: { path: ["tradeId"], equals: t7Id } }, { payload: { path: ["event"], equals: "ACCEPTED" } }],
    },
  });
  assert(acceptedLogs7.length === 1, `exactly one ACCEPTED log row for T7 despite two concurrent accept calls (got ${acceptedLogs7.length})`);

  // ===========================================================================
  console.log("\n== 5. Full trade freeze during a live draft ==");
  // ===========================================================================
  const preDraftGive = await fixture("PreDraftGive");
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: preDraftGive.id, callerUserId: "hardening-test-A" });
  const { tradeId: t5PreId } = await proposeTrade({
    leagueId, proposingTeamId: teamB, counterpartyTeamId: teamC, managerUserId: "hardening-test-B",
    give: { playerIds: [preDraftGive.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });

  const { draftId } = await setUpDraft({
    leagueId, season: LEAGUE_SEASON, type: "STARTUP", roundCount: 1,
    orderMode: "MANUAL", manualOrder: [teamA, teamB, teamC], pickTimerSeconds: 10,
    callerUserId: "hardening-test-A",
  });
  await startDraft({ draftId, callerUserId: "hardening-test-A" });

  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "hardening-test-A",
      give: { playerIds: [], pickIds: [], faabAmount: 0 },
      receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade while the draft is IN_PROGRESS",
    "paused while the draft is in progress",
  );
  await assertThrows(
    () => respondToTrade({ tradeId: t5PreId, managerUserId: "hardening-test-C", accept: true }),
    "respondToTrade accept while the draft is IN_PROGRESS",
    "paused while the draft is in progress",
  );

  const managerFor: Record<string, string> = { [teamA]: "hardening-test-A", [teamB]: "hardening-test-B", [teamC]: "hardening-test-C" };
  for (let i = 0; i < 3; i++) {
    const state = await resolveDraftState(draftId);
    if (state.status !== "IN_PROGRESS" || !state.currentPick) break;
    const onClock = state.currentPick.teamId;
    const top = state.pool[0];
    if (!top) throw new Error("Draft pool unexpectedly empty during the hardening check's 3-pick STARTUP draft.");
    await makeDraftPick({ draftId, playerId: top.id, managerUserId: managerFor[onClock] });
  }
  const draftFinal = await resolveDraftState(draftId);
  assert(draftFinal.status === "COMPLETE", "the 3-team/1-round STARTUP draft completed after 3 picks");

  await respondToTrade({ tradeId: t5PreId, managerUserId: "hardening-test-C", accept: true });
  const t5PreFinal = await prisma.trade.findUniqueOrThrow({ where: { id: t5PreId } });
  assert(t5PreFinal.state === "UNDER_REVIEW", "the pre-draft proposal can be accepted again once the draft is COMPLETE");

  const { tradeId: t5PostProposeId } = await proposeTrade({
    leagueId, proposingTeamId: teamC, counterpartyTeamId: teamA, managerUserId: "hardening-test-C",
    give: { playerIds: [], pickIds: [], faabAmount: 1 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  assert(!!t5PostProposeId, "a brand-new proposeTrade also works again once the draft is COMPLETE");

  // ===========================================================================
  console.log("\n== 9. Orphaning a team cancels its in-flight trades ==");
  // ===========================================================================
  const { tradeId: t9ProposedId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "hardening-test-A",
    give: { playerIds: [], pickIds: [], faabAmount: 1 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  const { tradeId: t9UnderReviewId } = await proposeTrade({
    leagueId, proposingTeamId: teamC, counterpartyTeamId: teamB, managerUserId: "hardening-test-C",
    give: { playerIds: [], pickIds: [], faabAmount: 1 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: t9UnderReviewId, managerUserId: "hardening-test-B", accept: true });
  const t9UrBefore = await prisma.trade.findUniqueOrThrow({ where: { id: t9UnderReviewId } });
  assert(t9UrBefore.state === "UNDER_REVIEW", "T9's second trade is UNDER_REVIEW going into the orphan test (FAAB-only, cap-immune)");

  // Replicates orphanTeamAction's sequence exactly (src/app/leagues/actions.ts)
  // — can't call the Server Action itself under plain tsx (auth.protect()
  // requires a real request context; same pre-existing limitation documented
  // for scripts/roster-action-check.ts).
  const inFlightForB = await prisma.trade.findMany({
    where: {
      leagueId,
      state: { in: ["PROPOSED", "UNDER_REVIEW"] },
      items: { some: { OR: [{ fromTeamId: teamB }, { toTeamId: teamB }] } },
    },
    select: { id: true },
  });
  for (const t of inFlightForB) {
    await cancelTrade({ tradeId: t.id, callerUserId: "hardening-test-A", allowUnderReview: true });
  }
  await setTeamManager({ leagueId, teamId: teamB, callerUserId: "hardening-test-A", orphan: true });

  const t9ProposedAfter = await prisma.trade.findUniqueOrThrow({ where: { id: t9ProposedId } });
  const t9UnderReviewAfter = await prisma.trade.findUniqueOrThrow({ where: { id: t9UnderReviewId } });
  assert(t9ProposedAfter.state === "CANCELLED", "the PROPOSED trade involving the orphaned team is CANCELLED");
  assert(t9UnderReviewAfter.state === "CANCELLED", "the UNDER_REVIEW trade involving the orphaned team is CANCELLED too");
  const teamBAfter = await prisma.team.findUniqueOrThrow({ where: { id: teamB } });
  assert(teamBAfter.state === "ORPHAN_FROZEN", "Team B is now ORPHAN_FROZEN");

  // ===========================================================================
  console.log("\n-- cleanup --");
  // ===========================================================================
  const fixturePlayers = await prisma.player.findMany({ where: { fullName: { contains: "Trade Hardening Test" } } });
  const fixtureIds = fixturePlayers.map((p) => p.id);
  await prisma.faBid.deleteMany({ where: { playerId: { in: fixtureIds } } });
  await deleteLeague(leagueId, "hardening-test-A");
  const deleted = await prisma.player.deleteMany({ where: { id: { in: fixtureIds } } });
  console.log(`cleaned up (${deleted.count} fixture players deleted, league removed, ${fixtureCounter} fixtures created)`);

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
