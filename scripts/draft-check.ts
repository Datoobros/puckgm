import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, resolveDraftState, makeDraftPick, getDraftPool, getCurrentDraft } from "@/lib/draft/mutations";
import { getTradeableAssets } from "@/lib/trades/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Draft Test League (delete me)",
    season: 2027,
    managerUserId: "draft-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "draft-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "draft-test-C", teamName: "Team C" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "draft-test-D", teamName: "Team D" });
  console.log("league:", leagueId, { teamA, teamB, teamC, teamD });

  console.log("\n-- ROOKIE setup rejects a season with no ingested draft class --");
  let rejectedNoClass = false;
  try {
    await setUpDraft({
      leagueId, season: 1899, type: "ROOKIE", roundCount: 1, orderMode: "RANDOM",
      pickTimerSeconds: 90, callerUserId: "draft-test-A",
    });
  } catch {
    rejectedNoClass = true;
  }
  assert(rejectedNoClass, "setUpDraft for ROOKIE with no ingested class throws");

  console.log("\n-- STARTUP draft: manual order, 2 rounds, 4 teams = 8 picks, snake --");
  const { draftId } = await setUpDraft({
    leagueId, season: 2027, type: "STARTUP", roundCount: 2, orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC, teamD], pickTimerSeconds: 10, callerUserId: "draft-test-A",
  });
  const picks = await prisma.draftPick.findMany({ where: { draftId }, orderBy: { overallPick: "asc" } });
  assert(picks.length === 8, "8 DraftPick rows created (4 teams x 2 rounds)");
  assert(
    picks.map((p) => p.currentOwnerId).join(",") === [teamA, teamB, teamC, teamD, teamD, teamC, teamB, teamA].join(","),
    "snake order is A,B,C,D then D,C,B,A — round 2 reverses round 1",
  );

  const currentDraft = await getCurrentDraft(leagueId);
  assert(currentDraft?.id === draftId, "getCurrentDraft finds the SETUP draft");

  console.log("\n-- picks are real, tradeable rows immediately (SETUP, before the clock even starts) --");
  const assetsA = await getTradeableAssets(teamA);
  assert(assetsA.picks.length === 2, "Team A already owns 2 tradeable DraftPick rows (overall 1 and 8)");

  console.log("\n-- start the draft, make a manual pick --");
  await startDraft({ draftId, callerUserId: "draft-test-A" });

  let wrongTurnThrew = false;
  try {
    await makeDraftPick({ draftId, playerId: "irrelevant", managerUserId: "draft-test-C" });
  } catch {
    wrongTurnThrew = true;
  }
  assert(wrongTurnThrew, "a team out of turn can't pick");

  const poolBeforePick1 = await getDraftPool({ leagueId, type: "STARTUP", season: 2027 });
  const firstPickPlayer = poolBeforePick1[0];
  await makeDraftPick({ draftId, playerId: firstPickPlayer.id, managerUserId: "draft-test-A" });
  const teamARoster = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: firstPickPlayer.id, effectiveTo: null } });
  assert(!!teamARoster && teamARoster.slotType === "ACTIVE", `Team A's pick (${firstPickPlayer.fullName}) landed on their ACTIVE roster`);
  const poolAfterPick1 = await getDraftPool({ leagueId, type: "STARTUP", season: 2027 });
  assert(!poolAfterPick1.some((p) => p.id === firstPickPlayer.id), "the drafted player no longer appears in the pool");

  console.log("\n-- deadline chaining: catches up through exactly as many picks as the elapsed time allows, not all-or-nothing --");
  // pickTimerSeconds is 10. Backdating the current deadline (now on pick #2,
  // Team B) by 25s should autopick picks #2 (B), #3 (C), and #4 (D) — each
  // chained deadline is +10s from the last, landing at -25000+10000+10000+10000
  // = +5000ms (5s in the future) by the time pick #5 is checked, which is
  // NOT yet due. Pick #5 (D again — the snake turn) should be left pending.
  await prisma.draft.update({ where: { id: draftId }, data: { currentPickDeadline: new Date(Date.now() - 25000) } });
  const stateAfterCatchUp = await resolveDraftState(draftId);
  const usedAfterCatchUp = await prisma.draftPick.count({ where: { draftId, usedOnPlayerId: { not: null } } });
  assert(usedAfterCatchUp === 4, "exactly 4 picks used total (1 manual + 3 chained autopicks), not all 8");
  assert(stateAfterCatchUp.currentPick?.teamName === "Team D" && stateAfterCatchUp.currentPick.round === 2, "current pick is Team D's round-2 turn (the snake) — not yet resolved");
  assert(stateAfterCatchUp.currentPick!.msRemaining > 0, "Team D's round-2 pick still has time left, not backdated");
  assert(stateAfterCatchUp.recentPicks.filter((p) => p.autopicked).length === 3, "3 of the recent picks are flagged autopicked");

  console.log("\n-- finish it off: a generous backdate completes the whole draft in one call --");
  await prisma.draft.update({ where: { id: draftId }, data: { currentPickDeadline: new Date(Date.now() - 100000) } });
  const finalState = await resolveDraftState(draftId);
  assert(finalState.status === "COMPLETE", "draft is COMPLETE after catching up through every remaining pick");
  const totalUsed = await prisma.draftPick.count({ where: { draftId, usedOnPlayerId: { not: null } } });
  assert(totalUsed === 8, "all 8 picks used");
  const activeCountA = await prisma.rosterSlot.count({ where: { teamId: teamA, slotType: "ACTIVE", effectiveTo: null } });
  assert(activeCountA === 2, "Team A ended up with 2 players (its 2 picks) on its ACTIVE roster, even though 2 exceeds nothing here but proves the cap isn't blocking draft assignment");

  console.log("\n-- a real ROOKIE draft against the actual ingested 2025 class --");
  const { draftId: rookieDraftId } = await setUpDraft({
    leagueId, season: 2025, type: "ROOKIE", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC, teamD], pickTimerSeconds: 10, callerUserId: "draft-test-A",
  });
  const rookiePool = await getDraftPool({ leagueId, type: "ROOKIE", season: 2025 });
  assert(rookiePool.length > 0, "the real 2025 draft class is a non-empty pool");
  assert(rookiePool[0].fullName === "Matthew Schaefer", "autopick priority for a ROOKIE draft is real draft order — the actual #1 overall pick (Matthew Schaefer) ranks first");
  await startDraft({ draftId: rookieDraftId, callerUserId: "draft-test-A" });
  await prisma.draft.update({ where: { id: rookieDraftId }, data: { currentPickDeadline: new Date(Date.now() - 100000) } });
  const rookieFinal = await resolveDraftState(rookieDraftId);
  assert(rookieFinal.status === "COMPLETE", "the 1-round rookie draft completes");
  assert(rookieFinal.recentPicks.some((p) => p.playerName === "Matthew Schaefer"), "Matthew Schaefer was actually drafted by whichever team picked first");

  console.log("\n-- cleanup (via the real deleteLeague, exercising its new Draft-model fix) --");
  await deleteLeague(leagueId, "draft-test-A");
  console.log("cleaned up (2025 draft-class Player rows intentionally kept — real, reusable data)");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
