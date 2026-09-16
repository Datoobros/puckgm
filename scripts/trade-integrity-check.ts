// Verifies Task 1 of plans/trades-batch.md (issues #4/#5, backend): trade
// locks (src/lib/trades/locks.ts), computeTradeFit, the propose/accept
// re-validation, supersede-on-accept, the on-waivers block, and the
// stuck-trade notification. Disposable league, cleaned up by exact name at
// the end (this DB is shared with production — see PROGRESS.md). Rosters
// via commissionerAddPlayer throughout — free agency is gated pre-draft
// (team-page batch Task 3) and this league never runs one.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { commissionerAddPlayer, commissionerDropPlayer, dropPlayerFromRoster, sendToFarm, placeOnIR, callUpToActive } from "@/lib/rosters/mutations";
import { setLineupSlot } from "@/lib/lineups/mutations";
import { proposeTrade, respondToTrade, computeTradeFit } from "@/lib/trades/mutations";
import { getTeamNotifications } from "@/lib/notifications/feed";

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

async function backdateReview(tradeId: string) {
  await prisma.trade.update({ where: { id: tradeId }, data: { reviewEndsAt: new Date(Date.now() - 1000) } });
}

async function main() {
  // Small caps (ACTIVE 3, FARM 1, IR 2) so overflow is easy to hit on purpose.
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Trade Integrity Test League (delete me)",
    season: 2031,
    managerUserId: "integrity-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 1,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "integrity-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "integrity-test-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  async function fixture(name: string, gp = 0) {
    return prisma.player.create({ data: { fullName: `Trade Integrity Test ${name} (delete me)`, primaryPosition: "C", careerNhlGp: gp } });
  }

  const a1 = await fixture("A1");
  const a2 = await fixture("A2");
  const a3 = await fixture("A3");
  const b1 = await fixture("B1");
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: a1.id, callerUserId: "integrity-test-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: a2.id, callerUserId: "integrity-test-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: a3.id, callerUserId: "integrity-test-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: b1.id, callerUserId: "integrity-test-A" });
  // Team A is now at its active cap (3).

  console.log("\n-- 1. propose where the proposer would end up over cap --");
  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
      give: { playerIds: [], pickIds: [], faabAmount: 0 },
      receive: { playerIds: [b1.id], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade (proposer would go 1 over cap)",
    "1 over your Active roster cap",
  );

  console.log("\n-- 2. valid 1-for-1 -> PROPOSED; drop proposer's player; accept throws 'no longer valid' --");
  const y = await fixture("Y");
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: y.id, callerUserId: "integrity-test-A" });
  const { tradeId: trade2Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
    give: { playerIds: [a1.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [y.id], pickIds: [], faabAmount: 0 },
  });
  const trade2Proposed = await prisma.trade.findUniqueOrThrow({ where: { id: trade2Id } });
  assert(trade2Proposed.state === "PROPOSED", "1-for-1 trade proposed cleanly (both sides fit)");
  // a1 isn't locked yet (still PROPOSED, not UNDER_REVIEW) — a commissioner
  // can still drop him directly.
  await commissionerDropPlayer({ leagueId, teamId: teamA, playerId: a1.id, callerUserId: "integrity-test-A" });
  await assertThrows(
    () => respondToTrade({ tradeId: trade2Id, managerUserId: "integrity-test-B", accept: true }),
    "respondToTrade accept (a1 no longer owned by the team that offered him)",
    "no longer valid",
  );
  const trade2AfterThrow = await prisma.trade.findUniqueOrThrow({ where: { id: trade2Id } });
  assert(trade2AfterThrow.state === "PROPOSED", "the blocked accept left trade2's state untouched");
  // Team A is now {a2, a3} (2 active).

  console.log("\n-- 3. 2-for-1 into a full acceptor -> accept throws 'You must drop 1 player'; commissioner-drop one -> accept succeeds --");
  const c1 = await fixture("C1");
  const c2 = await fixture("C2");
  const c3 = await fixture("C3");
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: c1.id, callerUserId: "integrity-test-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: c2.id, callerUserId: "integrity-test-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: c3.id, callerUserId: "integrity-test-A" });
  // Team C is now at its active cap (3).
  const { tradeId: trade3Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "integrity-test-A",
    give: { playerIds: [a2.id, a3.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [c1.id], pickIds: [], faabAmount: 0 },
  });
  await assertThrows(
    () => respondToTrade({ tradeId: trade3Id, managerUserId: "integrity-test-C", accept: true }),
    "respondToTrade accept (2-for-1 into a full Team C)",
    "You must drop 1 player",
  );
  await commissionerDropPlayer({ leagueId, teamId: teamC, playerId: c2.id, callerUserId: "integrity-test-A" });
  await respondToTrade({ tradeId: trade3Id, managerUserId: "integrity-test-C", accept: true });
  const trade3State = await prisma.trade.findUniqueOrThrow({ where: { id: trade3Id } });
  assert(trade3State.state === "UNDER_REVIEW", "accept succeeds once Team C has room -> UNDER_REVIEW");
  // Team A is {a2, a3} (2 active, both locked by trade3). Team C is {c1, c3}
  // (2 active, c1 locked by trade3) — both exactly at cap-1.

  console.log("\n-- 4. locked-player mechanics against trade3 --");
  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
      give: { playerIds: [a2.id], pickIds: [], faabAmount: 0 },
      receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade including a2 (locked by trade3)",
    "locked in a pending trade",
  );
  await assertThrows(
    () => dropPlayerFromRoster({ teamId: teamA, playerId: a2.id, managerUserId: "integrity-test-A" }),
    "dropPlayerFromRoster(a2)",
    "locked in a pending trade",
  );
  await assertThrows(
    () => sendToFarm({ leagueId, teamId: teamA, playerId: a3.id, managerUserId: "integrity-test-A" }),
    "sendToFarm(a3)",
    "locked in a pending trade",
  );
  await prisma.player.update({ where: { id: c1.id }, data: { officialRosterStatus: "IR" } });
  await assertThrows(
    () => placeOnIR({ leagueId, teamId: teamC, playerId: c1.id, managerUserId: "integrity-test-C" }),
    "placeOnIR(c1)",
    "locked in a pending trade",
  );

  // callUpToActive needs a FARM-tier player locked by a *different*
  // UNDER_REVIEW trade.
  const farmPlayer = await fixture("Farm");
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: farmPlayer.id, callerUserId: "integrity-test-A" });
  await sendToFarm({ leagueId, teamId: teamB, playerId: farmPlayer.id, managerUserId: "integrity-test-B" });
  const { tradeId: trade4Id } = await proposeTrade({
    leagueId, proposingTeamId: teamB, counterpartyTeamId: teamC, managerUserId: "integrity-test-B",
    give: { playerIds: [farmPlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: trade4Id, managerUserId: "integrity-test-C", accept: true });
  const trade4State = await prisma.trade.findUniqueOrThrow({ where: { id: trade4Id } });
  assert(trade4State.state === "UNDER_REVIEW", "farmPlayer's trade (B->C) accepted -> UNDER_REVIEW, farmPlayer now locked");
  await assertThrows(
    () => callUpToActive({ leagueId, teamId: teamB, playerId: farmPlayer.id, managerUserId: "integrity-test-B" }),
    "callUpToActive(farmPlayer)",
    "locked in a pending trade",
  );

  // Lineup slot changes are explicitly NOT gated — a locked player still
  // plays for his current owner until the trade processes. This is the
  // first lineup touch for Team A on this date, so setLineupSlot first
  // materializes the day (auto-filling one of a2/a3 into the single "C"
  // slot by career-points rank — a tie, so which one is unspecified). Bench
  // a3 explicitly first (bench has no capacity limit, and benching is also
  // not lock-gated) so the "C" slot is deterministically free before
  // asserting a2 — a locked player — can be placed into it.
  await setLineupSlot({ leagueId, teamId: teamA, playerId: a3.id, date: "2031-01-15", slot: "BE", managerUserId: "integrity-test-A" });
  await setLineupSlot({ leagueId, teamId: teamA, playerId: a2.id, date: "2031-01-15", slot: "C", managerUserId: "integrity-test-A" });
  console.log("  ok: setLineupSlot on a2 (locked) succeeds");

  // Commissioner override functions are explicitly NOT gated. Use a
  // dedicated player+trade for this so a2/a3/c1 stay untouched for the later
  // cap-1 / notification assertions below.
  const lockedForDrop = await fixture("LockedForDrop");
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: lockedForDrop.id, callerUserId: "integrity-test-A" });
  const { tradeId: trade5Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
    give: { playerIds: [lockedForDrop.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: trade5Id, managerUserId: "integrity-test-B", accept: true });
  await commissionerDropPlayer({ leagueId, teamId: teamA, playerId: lockedForDrop.id, callerUserId: "integrity-test-A" });
  console.log("  ok: commissionerDropPlayer on lockedForDrop (locked) succeeds");

  console.log("\n-- 5. accepting supersedes another PROPOSED trade on the same player --");
  const supersedeMe = await fixture("SupersedeMe");
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: supersedeMe.id, callerUserId: "integrity-test-A" });
  const { tradeId: tradeX1Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
    give: { playerIds: [], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [supersedeMe.id], pickIds: [], faabAmount: 0 },
  });
  const { tradeId: tradeX2Id } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "integrity-test-A",
    give: { playerIds: [], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [supersedeMe.id], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: tradeX1Id, managerUserId: "integrity-test-B", accept: true });
  const tradeX2After = await prisma.trade.findUniqueOrThrow({ where: { id: tradeX2Id } });
  assert(tradeX2After.state === "CANCELLED", "the second PROPOSED trade on the same player is CANCELLED once the first is accepted");
  const supersedeLog = await prisma.transactionLog.findFirst({
    where: {
      leagueId,
      type: "TRADE",
      AND: [
        { payload: { path: ["tradeId"], equals: tradeX2Id } },
        { payload: { path: ["event"], equals: "SUPERSEDED" } },
      ],
    },
  });
  assert(
    !!supersedeLog && (supersedeLog.payload as { byTradeId?: string }).byTradeId === tradeX1Id,
    "a SUPERSEDED log row exists for the cancelled trade, naming the trade that superseded it",
  );

  console.log("\n-- 6. a FARM player on waivers can't be traded --");
  const onWaiversPlayer = await fixture("OnWaivers", 200); // careerNhlGp 200 >= the 80 GP default threshold
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: onWaiversPlayer.id, callerUserId: "integrity-test-A" });
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamC, playerId: onWaiversPlayer.id, managerUserId: "integrity-test-C" });
  assert(waiverExposed, "onWaiversPlayer (200 career GP) is waiver-exposed on send-down");
  await assertThrows(
    () => proposeTrade({
      leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "integrity-test-A",
      give: { playerIds: [], pickIds: [], faabAmount: 0 },
      receive: { playerIds: [onWaiversPlayer.id], pickIds: [], faabAmount: 0 },
    }),
    "proposeTrade including onWaiversPlayer",
    "on waivers",
  );
  // Team C is back to {c1, c3} (2 active) — cap-1, same as Team A.

  console.log("\n-- 7. computeTradeFit reports excess per team per tier --");
  const hypotheticalFit = await computeTradeFit(leagueId, [
    { fromTeamId: teamA, toTeamId: teamC, itemType: "PLAYER", playerId: a2.id },
    { fromTeamId: teamA, toTeamId: teamC, itemType: "PLAYER", playerId: b1.id },
    { fromTeamId: teamA, toTeamId: teamC, itemType: "PLAYER", playerId: y.id },
  ]);
  assert(hypotheticalFit.fits === false, "a hypothetical 3-for-0 into a roster at cap-1 doesn't fit");
  const cOverflow = hypotheticalFit.overflow.find((o) => o.teamId === teamC && o.slotType === "ACTIVE");
  assert(cOverflow?.excess === 2, `Team C's ACTIVE overflow is exactly 2 (got: ${cOverflow?.excess})`);

  console.log("\n-- 8. getTeamNotifications flags a stuck (expired, still overflowing) UNDER_REVIEW trade --");
  const stuckPlayer = await fixture("Stuck");
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: stuckPlayer.id, callerUserId: "integrity-test-A" });
  const { tradeId: tradeStuckId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamC, managerUserId: "integrity-test-A",
    give: { playerIds: [stuckPlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: tradeStuckId, managerUserId: "integrity-test-C", accept: true }); // fits at accept time (C: 2 + 1 = 3 = cap)
  // Drift: Team C picks up one more player independently (e.g. a commissioner
  // override, in reality could be a waiver/FAAB award) after accepting —
  // this is exactly the scenario the stuck-trade notification exists for.
  const driftPlayer = await fixture("Drift");
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: driftPlayer.id, callerUserId: "integrity-test-A" });
  await backdateReview(tradeStuckId);

  const notificationsForC = await getTeamNotifications(leagueId, teamC);
  assert(
    notificationsForC.some((n) => n.kind === "TRADE_ACTION" && n.text.includes("drop 1 player(s)")),
    "Team C (the blocking side) gets a 'drop 1 player(s)' TRADE_ACTION notification",
  );
  const notificationsForA = await getTeamNotifications(leagueId, teamA);
  assert(
    notificationsForA.some((n) => n.text.includes("waiting on them to clear roster room")),
    "Team A (not blocking) gets a 'waiting on them' TRADE_PENDING notification instead",
  );

  console.log("\n-- cleanup --");
  const fixturePlayers = await prisma.player.findMany({ where: { fullName: { contains: "Trade Integrity Test" } } });
  const fixtureIds = fixturePlayers.map((p) => p.id);
  await deleteLeague(leagueId, "integrity-test-A");
  const deleted = await prisma.player.deleteMany({ where: { id: { in: fixtureIds } } });
  console.log(`cleaned up (${deleted.count} fixture players deleted, league removed)`);

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
