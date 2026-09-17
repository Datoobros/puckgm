// Regression check for LM Tools batch Task 4 — LM Make Trade. Exercises
// commissionerExecuteTrade directly (the "use server" action wrapper calls
// auth.protect(), which can't run outside a real request — same reasoning
// every other check script in this project already follows).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, setTeamManager } from "@/lib/leagues/mutations";
import { commissionerAddPlayer } from "@/lib/rosters/mutations";
import { commissionerExecuteTrade } from "@/lib/trades/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "LM Trade Test League (delete me)",
    season: 2031,
    managerUserId: "lmtrade-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    // Deliberately tiny active cap (2) so the overflow test doesn't need a
    // large fixture — 1 UTIL + 1 BENCH is the whole active roster.
    rosterComposition: { positionMode: "SEPARATE", C: 0, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 1, BENCH: 1 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lmtrade-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  console.log("\n-- player-for-pick LM trade --");
  const player1 = await prisma.player.create({ data: { fullName: "Lmtrade Player1 (delete me)", primaryPosition: "C" } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: player1.id, callerUserId: "lmtrade-A" });
  const pick1 = await prisma.draftPick.create({
    data: { leagueId, season: 2032, round: 1, originalTeamId: teamB, currentOwnerId: teamB },
  });

  const before = new Date();
  const { tradeId } = await commissionerExecuteTrade({
    leagueId,
    fromTeamId: teamA,
    toTeamId: teamB,
    give: { playerIds: [player1.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [pick1.id], faabAmount: 0 },
    callerUserId: "lmtrade-A",
  });

  const player1Slot = await prisma.rosterSlot.findFirst({ where: { playerId: player1.id, effectiveTo: null } });
  assert(player1Slot?.teamId === teamB, "the traded player's roster slot moved to Team B");
  const pick1After = await prisma.draftPick.findUniqueOrThrow({ where: { id: pick1.id } });
  assert(pick1After.currentOwnerId === teamA, "the traded pick's ownership moved to Team A");
  const trade = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(trade.state === "PROCESSED", "the trade is PROCESSED immediately, no review window");
  assert(trade.commissionerExecuted === true, "Trade.commissionerExecuted is set");
  const overrideLogs = await prisma.transactionLog.findMany({
    where: { leagueId, type: "TRADE", createdAt: { gte: before } },
  });
  const withOverrideFlag = overrideLogs.filter((l) => (l.payload as Record<string, unknown>).commissionerOverride === true);
  assert(withOverrideFlag.length === 1, `exactly one TRADE log has commissionerOverride: true (got ${withOverrideFlag.length})`);
  assert(
    (withOverrideFlag[0].payload as Record<string, unknown>).performedBy === "lmtrade-A",
    "that log row records who performed the override",
  );

  console.log("\n-- refused for a non-commissioner caller --");
  const player2 = await prisma.player.create({ data: { fullName: "Lmtrade Player2 (delete me)", primaryPosition: "D" } });
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: player2.id, callerUserId: "lmtrade-A" });
  await rejects(
    () =>
      commissionerExecuteTrade({
        leagueId, fromTeamId: teamB, toTeamId: teamA,
        give: { playerIds: [player2.id], pickIds: [], faabAmount: 0 },
        receive: { playerIds: [], pickIds: [], faabAmount: 0 },
        callerUserId: "lmtrade-B",
      }),
    "refused for a non-commissioner caller (lmtrade-B manages Team B, not the league)",
  );

  console.log("\n-- refused when a player is on waivers --");
  await prisma.rosterSlot.updateMany({
    where: { teamId: teamB, playerId: player2.id, effectiveTo: null },
    data: { waiverExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  await rejects(
    () =>
      commissionerExecuteTrade({
        leagueId, fromTeamId: teamB, toTeamId: teamA,
        give: { playerIds: [player2.id], pickIds: [], faabAmount: 0 },
        receive: { playerIds: [], pickIds: [], faabAmount: 0 },
        callerUserId: "lmtrade-A",
      }),
    "refused when a player is currently on waivers",
  );
  await prisma.rosterSlot.updateMany({
    where: { teamId: teamB, playerId: player2.id, effectiveTo: null },
    data: { waiverExpiresAt: null },
  });

  console.log("\n-- refused when a team is frozen --");
  await setTeamManager({ leagueId, teamId: teamB, callerUserId: "lmtrade-A", orphan: true });
  await rejects(
    () =>
      commissionerExecuteTrade({
        leagueId, fromTeamId: teamB, toTeamId: teamA,
        give: { playerIds: [player2.id], pickIds: [], faabAmount: 0 },
        receive: { playerIds: [], pickIds: [], faabAmount: 0 },
        callerUserId: "lmtrade-A",
      }),
    "refused when the giving team is ORPHAN_FROZEN",
  );
  await setTeamManager({ leagueId, teamId: teamB, callerUserId: "lmtrade-A", newManagerUserId: "lmtrade-B" });

  console.log("\n-- a trade that overflows the receiving roster still executes (bypass) --");
  // Team A's active cap is 2 (UTIL 1 + BENCH 1) — player1 left for Team B in
  // the first trade above, so Team A's active roster is empty again. Fill it
  // to the cap with two fresh players before the next trade, so receiving
  // one more genuinely overflows it.
  const filler1 = await prisma.player.create({ data: { fullName: "Lmtrade Filler1 (delete me)", primaryPosition: "L" } });
  const filler2 = await prisma.player.create({ data: { fullName: "Lmtrade Filler2 (delete me)", primaryPosition: "R" } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: filler1.id, callerUserId: "lmtrade-A" });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: filler2.id, callerUserId: "lmtrade-A" });
  const activeCountBefore = await prisma.rosterSlot.count({ where: { teamId: teamA, slotType: "ACTIVE", effectiveTo: null } });
  assert(activeCountBefore === 2, `Team A's active roster is already at its 2-player cap (got ${activeCountBefore})`);

  const { tradeId: overflowTradeId } = await commissionerExecuteTrade({
    leagueId, fromTeamId: teamB, toTeamId: teamA,
    give: { playerIds: [player2.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
    callerUserId: "lmtrade-A",
  });
  const overflowTrade = await prisma.trade.findUniqueOrThrow({ where: { id: overflowTradeId } });
  assert(overflowTrade.state === "PROCESSED", "the overflow trade still executes instead of staying pending");
  const activeCountAfter = await prisma.rosterSlot.count({ where: { teamId: teamA, slotType: "ACTIVE", effectiveTo: null } });
  assert(activeCountAfter === 3, `Team A's active roster is now over its cap (3 > 2 max), confirming the bypass (got ${activeCountAfter})`);

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lmtrade-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
