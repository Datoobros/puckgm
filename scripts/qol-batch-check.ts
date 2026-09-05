// Regression check for the QoL batch: league type (DYNASTY/REDRAFT),
// position mode (SEPARATE/COMBINED forwards), per-league season, invite
// links. Dynasty/separate regression coverage is the existing
// waiver/FAAB/trades/playoffs/draft-check.ts scripts, re-run unmodified
// (aside from the RosterComposition shape update every script needed) —
// this file only covers what's actually new.

import { prisma } from "@/lib/db";
import {
  createLeague,
  createTeam,
  deleteLeague,
  updateLeagueSettings,
  regenerateInviteCode,
  getLeagueByInviteCode,
  getLeagueCommissioner,
} from "@/lib/leagues/mutations";
import { startNewSeason } from "@/lib/leagues/season";
import { setUpDraft, startDraft, getDraftPool, makeDraftPick } from "@/lib/draft/mutations";
import { proposeTrade, getTradeableAssets } from "@/lib/trades/mutations";
import { activeRosterCap } from "@/lib/rosters/mutations";
import { capFor, eligibleSlotsForPosition } from "@/lib/lineups/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log("-- position-mode lineup eligibility (unit-level, no DB) --");
  assert(
    eligibleSlotsForPosition("C", "SEPARATE").join(",") === "C,UTIL",
    "SEPARATE mode: a center is eligible for C and UTIL",
  );
  assert(
    eligibleSlotsForPosition("C", "COMBINED").join(",") === "F,UTIL",
    "COMBINED mode: a center is eligible for F (not C) and UTIL",
  );
  assert(
    eligibleSlotsForPosition("C", "SEPARATE").includes("C") && !eligibleSlotsForPosition("C", "SEPARATE").includes("F"),
    "SEPARATE mode never produces an F slot",
  );
  const combinedComp = { positionMode: "COMBINED" as const, C: 0, LW: 0, RW: 0, F: 8, D: 4, G: 2, UTIL: 1, BENCH: 6 };
  assert(capFor("F", combinedComp) === 8, "capFor resolves the F slot from RosterComposition.F");
  assert(capFor("C", combinedComp) === 0, "capFor falls back to 0 for an unused SEPARATE-only slot in COMBINED mode");

  console.log("\n-- REDRAFT + COMBINED league end to end --");
  const { leagueId, teamId: teamA } = await createLeague({
    name: "QoL Batch Test League (delete me)",
    season: 2030,
    managerUserId: "qol-test-A",
    teamName: "Team A",
    leagueType: "REDRAFT",
    rosterComposition: { positionMode: "COMBINED", C: 0, LW: 0, RW: 0, F: 2, D: 2, G: 1, UTIL: 1, BENCH: 3 },
    farmSlots: 99, // deliberately wrong — createLeague must force this to 0
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "qol-test-B", teamName: "Team B" });

  const leagueRow = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  assert(leagueRow.currentSeason === 2030, "currentSeason is set from the creation season input");

  const settingsAfterCreate = (await prisma.league.findUniqueOrThrow({ where: { id: leagueId } })).settingsJson as any;
  assert(settingsAfterCreate.farmSlots === 0, "REDRAFT forces farmSlots to 0 at creation regardless of submitted value");
  assert(settingsAfterCreate.rosterComposition.positionMode === "COMBINED", "positionMode persisted as COMBINED");
  assert(typeof activeRosterCap(settingsAfterCreate) === "number", "activeRosterCap returns a number, not a string, for a COMBINED-mode league");
  assert(activeRosterCap(settingsAfterCreate) === 2 + 2 + 1 + 1 + 3, "activeRosterCap sums only the numeric slot counts (positionMode excluded)");

  let rejectedFarmEdit = false;
  try {
    await updateLeagueSettings({
      leagueId,
      callerUserId: "qol-test-A",
      farmSlots: 5,
      irSlots: 2,
      waiverGpThreshold: 80,
      callupsPerWeek: 2,
      scoringConfig: {},
      faabEnabled: false,
      faabBudget: 100,
      faabMinBid: 1,
      faabMaxBid: null,
      tradeVetoMode: "COMMISSIONER",
      tradeDeadline: null,
      rosterComposition: { positionMode: "COMBINED", C: 0, LW: 0, RW: 0, F: 2, D: 2, G: 1, UTIL: 1, BENCH: 3 },
      draftPickTradingEnabled: true,
    });
  } catch {
    rejectedFarmEdit = true;
  }
  assert(rejectedFarmEdit, "updateLeagueSettings rejects a nonzero farmSlots edit on a REDRAFT league");

  console.log("\n-- startup draft (2 rounds, manual order A,B) — draft picks 1 and 2, leave 3 and 4 open --");
  const { draftId } = await setUpDraft({
    leagueId, season: 2030, type: "STARTUP", roundCount: 2, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 600, callerUserId: "qol-test-A",
  });
  await startDraft({ draftId, callerUserId: "qol-test-A" });
  const pool1 = await getDraftPool({ leagueId, type: "STARTUP", season: 2030 });
  await makeDraftPick({ draftId, playerId: pool1[0].id, managerUserId: "qol-test-A" });
  const pool2 = await getDraftPool({ leagueId, type: "STARTUP", season: 2030 });
  await makeDraftPick({ draftId, playerId: pool2[0].id, managerUserId: "qol-test-B" });

  const draftedPlayerIds = [pool1[0].id, pool2[0].id];
  const rosteredBefore = await prisma.rosterSlot.count({ where: { team: { leagueId }, effectiveTo: null } });
  assert(rosteredBefore === 2, "exactly 2 players rostered after 2 manual picks (picks 3-4 left open)");

  console.log("\n-- propose a trade (a draft pick, still pending) --");
  const assetsA = await getTradeableAssets(teamA);
  const openPick = assetsA.picks[0];
  assert(!!openPick, "Team A has at least one open, tradeable draft pick left");
  const { tradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamB,
    managerUserId: "qol-test-A",
    give: { playerIds: [], pickIds: [openPick.id], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  const tradeBefore = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(tradeBefore.state === "PROPOSED", "trade sits PROPOSED, not yet accepted");

  console.log("\n-- start new season --");
  let rejectedAsNonCommissioner = false;
  try {
    await startNewSeason(leagueId, "qol-test-B");
  } catch {
    rejectedAsNonCommissioner = true;
  }
  assert(rejectedAsNonCommissioner, "only the commissioner can start a new season");

  const { newSeason } = await startNewSeason(leagueId, "qol-test-A");
  assert(newSeason === 2031, "currentSeason advances by exactly 1");

  const tradeAfter = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(tradeAfter.state === "CANCELLED", "the pending trade was cancelled by the season rollover");

  const rosteredAfter = await prisma.rosterSlot.count({ where: { team: { leagueId }, effectiveTo: null } });
  assert(rosteredAfter === 0, "every roster slot was closed out — nobody is rostered anymore");

  console.log("\n-- a fresh startup draft for the new season sees everyone available again --");
  const { draftId: draftId2 } = await setUpDraft({
    leagueId, season: newSeason, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 600, callerUserId: "qol-test-A",
  });
  const pool3 = await getDraftPool({ leagueId, type: "STARTUP", season: newSeason });
  assert(
    draftedPlayerIds.every((id) => pool3.some((p) => p.id === id)),
    "both players drafted last season are back in the pool after the reset",
  );
  void draftId2; // left as SETUP — deleteLeague's teardown clears every Draft/DraftPick for the league below

  console.log("\n-- invite links --");
  assert((await getLeagueByInviteCode("not-a-real-code")) === null, "an unknown invite code resolves to nothing");
  const { inviteCode: code1 } = await regenerateInviteCode(leagueId, "qol-test-A");
  const foundByCode = await getLeagueByInviteCode(code1);
  assert(foundByCode?.id === leagueId, "a freshly generated invite code resolves back to the league");

  let rejectedNonCommissionerInvite = false;
  try {
    await regenerateInviteCode(leagueId, "qol-test-B");
  } catch {
    rejectedNonCommissionerInvite = true;
  }
  assert(rejectedNonCommissionerInvite, "only the commissioner can regenerate the invite code");

  const { inviteCode: code2 } = await regenerateInviteCode(leagueId, "qol-test-A");
  assert(code1 !== code2, "regenerating produces a different code");
  assert((await getLeagueByInviteCode(code1)) === null, "the old code no longer resolves after regenerating");
  assert((await getLeagueByInviteCode(code2))?.id === leagueId, "the new code resolves to the league");

  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "qol-test-C", teamName: "Team C" });
  const commissionerStillA = await getLeagueCommissioner(leagueId);
  assert(commissionerStillA === "qol-test-A", "joining via the invite-resolved leagueId doesn't disturb the commissioner");
  assert(!!teamC, "a new manager can join through the invite-resolved league (the actual join action does exactly this: resolve code -> createTeam)");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "qol-test-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
