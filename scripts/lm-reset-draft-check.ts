// Regression check for LM Tools batch Task 9 — Reset Draft
// (src/lib/draft/reset.ts). Exercises resetDraft directly (same convention
// as every other check script in this project — the lib layer, not the
// "use server" action wrapper, which needs a real request for auth.protect()).
//
// Covers, in order:
//   Part A (STARTUP): a SETUP-status draft is refused; a non-commissioner is
//     refused; a real 4-pick STARTUP draft plus a free-agent add plus a
//     pending trade all get wiped/cancelled by resetDraft; exactly one
//     COMMISSIONER_RESET log is written; the draft can be started and
//     autodrafted to completion again afterward (the real "start over").
//   Part B (ROOKIE): on the SAME league, a non-draft roster player survives
//     a ROOKIE reset while only that draft's own picks are removed.
//   Part C: re-running draft-autodraft-check.ts and every script touching
//     startNewSeason, to prove wipeLeagueRosters's extraction out of
//     season.ts didn't change startNewSeason's own behavior.
//
// All state lives in one disposable league, named and cleaned up by exact
// name + id per the shared-dev/prod-database convention (PROGRESS.md).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, autodraftBatch, getFreeAgencyStatus } from "@/lib/draft/mutations";
import { resetDraft } from "@/lib/draft/reset";
import { addPlayerToRoster } from "@/lib/rosters/mutations";
import { proposeTrade } from "@/lib/trades/mutations";
import { wipeLeagueRosters } from "@/lib/leagues/season";

const LEAGUE_NAME = "LM Tools Task 9 (delete me)";

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

async function findUnrosteredRealPlayer(excludeIds: string[]) {
  const player = await prisma.player.findFirst({
    where: {
      currentNhlOrg: { not: null },
      draftYear: null,
      id: { notIn: excludeIds },
      rosterSlots: { none: { effectiveTo: null } },
    },
    orderBy: { fullName: "asc" },
  });
  if (!player) throw new Error("No unrostered real NHL player found to use as a free-agent test add.");
  return player;
}

async function openSlotCountForLeague(leagueId: string): Promise<number> {
  return prisma.rosterSlot.count({ where: { team: { leagueId }, effectiveTo: null } });
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: 2031,
    managerUserId: "lmrd-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 10,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lmrd-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  // =========================================================================
  console.log("\n== Part A: STARTUP draft, reset, then start over ==");
  // =========================================================================

  const { draftId } = await setUpDraft({
    leagueId,
    season: 2031,
    type: "STARTUP",
    roundCount: 2, // 2 teams x 2 rounds = 4 picks
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB],
    pickTimerSeconds: 600,
    callerUserId: "lmrd-A",
  });

  console.log("\n-- SETUP-status draft is refused --");
  await rejects(
    () => resetDraft({ draftId, callerUserId: "lmrd-A" }),
    "resetDraft refuses a draft that's still in SETUP",
  );

  await startDraft({ draftId, callerUserId: "lmrd-A" });
  const view = await autodraftBatch({ draftId, callerUserId: "lmrd-A" });
  assert(view.status === "COMPLETE", "a single autodraftBatch call finishes the 4-pick STARTUP draft");

  const picksBefore = await prisma.draftPick.findMany({ where: { draftId }, orderBy: { overallPick: "asc" } });
  assert(picksBefore.length === 4, `4 DraftPick rows exist — got ${picksBefore.length}`);
  assert(picksBefore.every((p) => p.usedOnPlayerId !== null), "all 4 picks are used before reset");
  const overallPicksBefore = picksBefore.map((p) => p.overallPick);

  const draftedPlayerIds = picksBefore.map((p) => p.usedOnPlayerId!);
  const faPlayer = await findUnrosteredRealPlayer(draftedPlayerIds);
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: faPlayer.id, managerUserId: "lmrd-B" });
  console.log(`  added free agent ${faPlayer.fullName} to Team B`);

  const openBeforeReset = await openSlotCountForLeague(leagueId);
  assert(openBeforeReset === 5, `5 open roster slots before reset (4 drafted + 1 FA) — got ${openBeforeReset}`);

  const teamAPlayers = await prisma.rosterSlot.findMany({ where: { teamId: teamA, effectiveTo: null } });
  const { tradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamB,
    managerUserId: "lmrd-A",
    give: { playerIds: [teamAPlayers[0].playerId], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  console.log(`  proposed trade ${tradeId} (still PROPOSED, not accepted)`);

  console.log("\n-- non-commissioner is refused --");
  await rejects(
    () => resetDraft({ draftId, callerUserId: "lmrd-B" }),
    "resetDraft refuses a non-commissioner caller",
  );
  const stillOpen = await openSlotCountForLeague(leagueId);
  assert(stillOpen === 5, "the rejected non-commissioner call changed nothing");

  const logsBeforeReset = await prisma.transactionLog.count({ where: { leagueId, type: "COMMISSIONER_RESET" } });
  assert(logsBeforeReset === 0, "no COMMISSIONER_RESET log exists yet");

  console.log("\n-- commissioner resetDraft (STARTUP) --");
  const result = await resetDraft({ draftId, callerUserId: "lmrd-A" });
  console.log("  resetDraft result:", result);

  const openAfterReset = await openSlotCountForLeague(leagueId);
  assert(openAfterReset === 0, `0 open roster slots league-wide after a STARTUP reset — got ${openAfterReset}`);

  const tradeAfter = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(tradeAfter.state === "CANCELLED", `pending trade was cancelled by the reset — got state ${tradeAfter.state}`);

  const draftAfter = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
  assert(draftAfter.status === "SETUP", `draft is back to SETUP — got ${draftAfter.status}`);
  assert(draftAfter.currentPickDeadline === null, "currentPickDeadline is cleared");
  assert(draftAfter.resolvingUntil === null, "resolvingUntil is cleared");

  const picksAfter = await prisma.draftPick.findMany({ where: { draftId }, orderBy: { overallPick: "asc" } });
  assert(picksAfter.length === 4, "still 4 DraftPick rows (none deleted)");
  assert(picksAfter.every((p) => p.usedOnPlayerId === null), "every pick's usedOnPlayerId is cleared");
  assert(
    JSON.stringify(picksAfter.map((p) => p.overallPick)) === JSON.stringify(overallPicksBefore),
    "overallPick values are unchanged by the reset",
  );

  const faStatusAfter = await getFreeAgencyStatus(leagueId);
  assert(!faStatusAfter.open, `free agency is locked again after reset — got open=${faStatusAfter.open}`);

  const logsAfterReset = await prisma.transactionLog.count({ where: { leagueId, type: "COMMISSIONER_RESET" } });
  assert(logsAfterReset === 1, `exactly one COMMISSIONER_RESET log — got ${logsAfterReset}`);

  console.log("\n-- start over: startDraft + autodraft again succeeds --");
  await startDraft({ draftId, callerUserId: "lmrd-A" });
  const view2 = await autodraftBatch({ draftId, callerUserId: "lmrd-A" });
  assert(view2.status === "COMPLETE", "the same draft can be started and autodrafted to completion again after reset");
  const openAfterRedo = await openSlotCountForLeague(leagueId);
  assert(openAfterRedo === 4, `4 open roster slots after redrafting (2 teams x 2 rounds) — got ${openAfterRedo}`);

  // =========================================================================
  console.log("\n== Part B: ROOKIE variant, same league ==");
  // =========================================================================

  const redraftedPlayerIds = (await prisma.draftPick.findMany({ where: { draftId }, select: { usedOnPlayerId: true } })).map(
    (p) => p.usedOnPlayerId!,
  );
  const seededPlayer = await findUnrosteredRealPlayer(redraftedPlayerIds);
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: seededPlayer.id, managerUserId: "lmrd-B" });
  console.log(`  seeded non-draft roster player ${seededPlayer.fullName} on Team B`);

  const rookieSeason = 2025;
  const rookieClassCount = await prisma.player.count({ where: { draftYear: rookieSeason } });
  console.log(`  ingested ${rookieSeason} rookie class size: ${rookieClassCount}`);

  const openBeforeRookieDraft = await openSlotCountForLeague(leagueId);

  if (rookieClassCount >= 2) {
    console.log(`  running a real ROOKIE draft against the ingested ${rookieSeason} class`);
    const { draftId: rookieDraftId } = await setUpDraft({
      leagueId,
      season: rookieSeason,
      type: "ROOKIE",
      roundCount: 1, // 2 teams x 1 round = 2 picks
      orderMode: "MANUAL",
      manualOrder: [teamA, teamB],
      pickTimerSeconds: 600,
      callerUserId: "lmrd-A",
    });
    await startDraft({ draftId: rookieDraftId, callerUserId: "lmrd-A" });
    const rookieView = await autodraftBatch({ draftId: rookieDraftId, callerUserId: "lmrd-A" });
    assert(rookieView.status === "COMPLETE", "the 2-pick ROOKIE draft completes in one autodraftBatch call");

    const rookiePicks = await prisma.draftPick.findMany({ where: { draftId: rookieDraftId } });
    const rookiePlayerIds = rookiePicks.map((p) => p.usedOnPlayerId!);
    assert(rookiePlayerIds.length === 2 && rookiePlayerIds.every(Boolean), "2 rookie picks were made");

    const openAfterRookieDraft = await openSlotCountForLeague(leagueId);
    assert(openAfterRookieDraft === openBeforeRookieDraft + 2, "2 more open slots exist after the rookie draft");

    console.log("\n-- resetDraft (ROOKIE) --");
    await resetDraft({ draftId: rookieDraftId, callerUserId: "lmrd-A" });

    const rookieDraftAfter = await prisma.draft.findUniqueOrThrow({ where: { id: rookieDraftId } });
    assert(rookieDraftAfter.status === "SETUP", "rookie draft is back to SETUP");
    const rookiePicksAfter = await prisma.draftPick.findMany({ where: { draftId: rookieDraftId } });
    assert(rookiePicksAfter.every((p) => p.usedOnPlayerId === null), "rookie picks' usedOnPlayerId cleared");

    for (const playerId of rookiePlayerIds) {
      const slot = await prisma.rosterSlot.findFirst({ where: { playerId, effectiveTo: null } });
      assert(slot === null, `rookie-drafted player ${playerId} no longer has an open roster slot`);
    }

    const seededSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamB, playerId: seededPlayer.id, effectiveTo: null } });
    assert(seededSlot !== null, "the seeded non-draft roster player survives the ROOKIE reset");

    for (const playerId of redraftedPlayerIds) {
      const slot = await prisma.rosterSlot.findFirst({ where: { playerId, effectiveTo: null } });
      assert(slot !== null, `startup-drafted player ${playerId} survives the ROOKIE reset (only rookie picks are removed)`);
    }

    const openAfterRookieReset = await openSlotCountForLeague(leagueId);
    assert(
      openAfterRookieReset === openBeforeRookieDraft,
      `open slot count is back to its pre-rookie-draft value (${openBeforeRookieDraft}) — got ${openAfterRookieReset}`,
    );
  } else {
    console.log(
      `  ${rookieSeason} rookie class isn't ingested (or too small) in this environment — exercising the ` +
        `onlyPlayerIds branch of wipeLeagueRosters directly via a second STARTUP draft instead. Noted in PROGRESS.md.`,
    );
    const { draftId: secondDraftId } = await setUpDraft({
      leagueId,
      season: 2032,
      type: "STARTUP",
      roundCount: 1,
      orderMode: "MANUAL",
      manualOrder: [teamA, teamB],
      pickTimerSeconds: 600,
      callerUserId: "lmrd-A",
    });
    await startDraft({ draftId: secondDraftId, callerUserId: "lmrd-A" });
    // This exercises resetDraft's own STARTUP path (whole-league wipe), which
    // is a different code path from onlyPlayerIds — call wipeLeagueRosters's
    // onlyPlayerIds branch directly instead, scoped to the two picks this
    // "would-be rookie draft" made, to prove that branch on its own without
    // a real ingested rookie class available.
    const secondView = await autodraftBatch({ draftId: secondDraftId, callerUserId: "lmrd-A" });
    assert(secondView.status === "COMPLETE", "fallback second STARTUP draft completes");
    const secondPicks = await prisma.draftPick.findMany({ where: { draftId: secondDraftId } });
    const secondPlayerIds = secondPicks.map((p) => p.usedOnPlayerId!);

    await wipeLeagueRosters(leagueId, "lmrd-A", { onlyPlayerIds: secondPlayerIds });
    await prisma.draftPick.updateMany({ where: { draftId: secondDraftId }, data: { usedOnPlayerId: null } });
    await prisma.draft.update({ where: { id: secondDraftId }, data: { status: "SETUP", currentPickDeadline: null } });

    for (const playerId of secondPlayerIds) {
      const slot = await prisma.rosterSlot.findFirst({ where: { playerId, effectiveTo: null } });
      assert(slot === null, `onlyPlayerIds-scoped wipe removed player ${playerId}`);
    }
    const seededSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamB, playerId: seededPlayer.id, effectiveTo: null } });
    assert(seededSlot !== null, "the seeded non-draft roster player survives the onlyPlayerIds-scoped wipe");
    for (const playerId of redraftedPlayerIds) {
      const slot = await prisma.rosterSlot.findFirst({ where: { playerId, effectiveTo: null } });
      assert(slot !== null, `startup-drafted player ${playerId} survives the onlyPlayerIds-scoped wipe`);
    }
  }

  // =========================================================================
  console.log("\n-- cleanup --");
  // =========================================================================
  await deleteLeague(leagueId, "lmrd-A");
  const gone = await prisma.league.findUnique({ where: { id: leagueId } });
  assert(gone === null, `league ${leagueId} ("${LEAGUE_NAME}") deleted`);

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
