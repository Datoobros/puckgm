// Verifies Task 3's free-agency gate (issue #5, plans/team-page-batch.md) —
// see src/lib/draft/mutations.ts's getFreeAgencyStatus/assertFreeAgencyOpen.
// Disposable league, cleaned up by exact name at the end (this DB is shared
// with production — see PROGRESS.md).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, makeDraftPick, getDraftPool, getFreeAgencyStatus } from "@/lib/draft/mutations";
import { addPlayerToRoster } from "@/lib/rosters/mutations";
import { submitFaBid } from "@/lib/faab/mutations";
import { submitWaiverClaim } from "@/lib/waivers/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function assertThrowsClosed(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    assert(false, `${label} throws while free agency is closed`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("Free agency is closed"), `${label} throws the free-agency-closed error (got: "${msg}")`);
  }
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "FA Gate Test League (delete me)",
    season: 2027,
    managerUserId: "fa-gate-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "fa-gate-test-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  const somePlayer = await prisma.player.findFirstOrThrow({ where: { draftYear: null } });

  console.log("\n-- before any draft: closed, reason NO_STARTUP_DRAFT --");
  let statusBefore = await getFreeAgencyStatus(leagueId);
  assert(!statusBefore.open && statusBefore.reason === "NO_STARTUP_DRAFT", "getFreeAgencyStatus is closed/NO_STARTUP_DRAFT pre-draft");
  await assertThrowsClosed(
    () => addPlayerToRoster({ leagueId, teamId: teamA, playerId: somePlayer.id, managerUserId: "fa-gate-test-A" }),
    "addPlayerToRoster",
  );
  await assertThrowsClosed(
    () => submitFaBid({ leagueId, playerId: somePlayer.id, amount: 1, targetSlot: "ACTIVE", managerUserId: "fa-gate-test-A" }),
    "submitFaBid",
  );
  await assertThrowsClosed(
    () => submitWaiverClaim({ leagueId, playerId: somePlayer.id, managerUserId: "fa-gate-test-A" }),
    "submitWaiverClaim",
  );

  console.log("\n-- STARTUP draft: SETUP still closed, IN_PROGRESS closed (DRAFT_IN_PROGRESS), COMPLETE opens it --");
  const { draftId: startupDraftId } = await setUpDraft({
    leagueId, season: 2027, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 10, callerUserId: "fa-gate-test-A",
  });
  const statusSetup = await getFreeAgencyStatus(leagueId);
  assert(!statusSetup.open && statusSetup.reason === "NO_STARTUP_DRAFT", "still closed/NO_STARTUP_DRAFT with a STARTUP draft only in SETUP");

  await startDraft({ draftId: startupDraftId, callerUserId: "fa-gate-test-A" });
  const statusInProgress = await getFreeAgencyStatus(leagueId);
  assert(!statusInProgress.open && statusInProgress.reason === "DRAFT_IN_PROGRESS", "closed/DRAFT_IN_PROGRESS once the STARTUP draft starts");

  // 1 round x 2 teams = 2 picks total — make both manually so the draft
  // completes deterministically without relying on the timer.
  for (let i = 0; i < 2; i++) {
    const pool = await getDraftPool({ leagueId, type: "STARTUP", season: 2027 });
    const current = await prisma.draftPick.findFirst({ where: { draftId: startupDraftId, usedOnPlayerId: null }, orderBy: { overallPick: "asc" }, include: { currentOwner: true } });
    if (!current) break;
    const managerUserId = current.currentOwnerId === teamA ? "fa-gate-test-A" : "fa-gate-test-B";
    await makeDraftPick({ draftId: startupDraftId, playerId: pool[0].id, managerUserId });
  }
  const startupDraftAfter = await prisma.draft.findUniqueOrThrow({ where: { id: startupDraftId } });
  assert(startupDraftAfter.status === "COMPLETE", "STARTUP draft is COMPLETE after both picks");

  const statusAfterStartup = await getFreeAgencyStatus(leagueId);
  assert(statusAfterStartup.open, "getFreeAgencyStatus reports open once the STARTUP draft completes");
  // somePlayer was only ever used in calls that threw before persisting
  // anything, so it's still a free agent — confirms the gate, not just that
  // *some* player can be added.
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: somePlayer.id, managerUserId: "fa-gate-test-A" });
  console.log("  ok: addPlayerToRoster succeeds once free agency is open");

  console.log("\n-- a later ROOKIE draft re-closes free agency only while it's IN_PROGRESS, and the resolve-on-read case --");
  const { draftId: rookieDraftId } = await setUpDraft({
    leagueId, season: 2025, type: "ROOKIE", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 10, callerUserId: "fa-gate-test-A",
  });
  const statusRookieSetup = await getFreeAgencyStatus(leagueId);
  assert(statusRookieSetup.open, "still open with a second (ROOKIE) draft only in SETUP — the STARTUP completion already satisfied the gate");

  await startDraft({ draftId: rookieDraftId, callerUserId: "fa-gate-test-A" });
  const statusRookieInProgress = await getFreeAgencyStatus(leagueId);
  assert(!statusRookieInProgress.open && statusRookieInProgress.reason === "DRAFT_IN_PROGRESS", "closed/DRAFT_IN_PROGRESS again while the ROOKIE draft is running");
  await assertThrowsClosed(
    () => addPlayerToRoster({ leagueId, teamId: teamA, playerId: somePlayer.id, managerUserId: "fa-gate-test-A" }),
    "addPlayerToRoster (re-closed during the rookie draft)",
  );

  // Resolve-on-read: backdate the pick deadline well into the past — as if
  // the 10s timer had fully elapsed with nobody watching the draft room —
  // WITHOUT calling resolveDraftState ourselves first. getFreeAgencyStatus
  // must trigger that resolution itself (see its header comment) rather
  // than trusting the stale IN_PROGRESS row.
  await prisma.draft.update({ where: { id: rookieDraftId }, data: { currentPickDeadline: new Date(Date.now() - 1_000_000) } });
  const statusResolveOnRead = await getFreeAgencyStatus(leagueId);
  assert(statusResolveOnRead.open, "getFreeAgencyStatus resolves the overdue draft itself and reports open (autopicks ran)");
  const rookieDraftAfter = await prisma.draft.findUniqueOrThrow({ where: { id: rookieDraftId } });
  assert(rookieDraftAfter.status === "COMPLETE", "the rookie draft actually completed via autopick, not just the status check being stale");
  const rookiePicksUsed = await prisma.draftPick.count({ where: { draftId: rookieDraftId, usedOnPlayerId: { not: null } } });
  assert(rookiePicksUsed === 2, "both rookie-draft picks were autopicked");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "fa-gate-test-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
