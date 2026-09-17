// Regression check for LM Tools batch Task 3 — LM Roster Moves. Exercises the
// underlying lib mutations settings/roster-moves/actions.ts's LM/TM dispatch
// calls into (commissionerAddPlayer/commissionerDropPlayer/commissionerMovePlayer
// for League Manager mode, the plain manager-facing mutations for Team
// Manager mode), the same way every other check script in this project tests
// the lib layer directly rather than the "use server" action wrappers (which
// call auth.protect() and can't run outside a real request).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, setTeamManager } from "@/lib/leagues/mutations";
import {
  commissionerAddPlayer,
  commissionerDropPlayer,
  commissionerMovePlayer,
  addPlayerToRoster,
  sendToFarm,
  getTeamRosterView,
} from "@/lib/rosters/mutations";
import { setUpDraft, startDraft, autodraftBatch } from "@/lib/draft/mutations";

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
    name: "LM Roster Moves Test League (delete me)",
    season: 2031,
    managerUserId: "lmrm-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lmrm-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  console.log("\n-- LM add to FARM lands in FARM --");
  const farmPlayer = await prisma.player.create({ data: { fullName: "Lmrm Farm Add (delete me)", primaryPosition: "C" } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: farmPlayer.id, callerUserId: "lmrm-A", targetSlotType: "FARM" });
  const farmSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: farmPlayer.id, effectiveTo: null } });
  assert(farmSlot?.slotType === "FARM", "commissionerAddPlayer with targetSlotType FARM lands the player on Farm, not Active");

  console.log("\n-- free agency closed: TM add refused, LM add succeeds --");
  const gatedPlayer = await prisma.player.create({ data: { fullName: "Lmrm Gate Test (delete me)", primaryPosition: "D" } });
  await rejects(
    () => addPlayerToRoster({ leagueId, teamId: teamB, playerId: gatedPlayer.id, managerUserId: "lmrm-B" }),
    "TM-mode add (addPlayerToRoster) is refused by the free-agency gate before any startup draft completes",
  );
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: gatedPlayer.id, callerUserId: "lmrm-A" });
  const gatedSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamB, playerId: gatedPlayer.id, effectiveTo: null } });
  assert(gatedSlot?.slotType === "ACTIVE", "LM-mode add (commissionerAddPlayer) bypasses the same free-agency gate");

  console.log("\n-- opening free agency for the rest of this script (throwaway 1-round draft) --");
  const { draftId } = await setUpDraft({
    leagueId, season: 2020, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 600, callerUserId: "lmrm-A",
  });
  await startDraft({ draftId, callerUserId: "lmrm-A" });
  const view = await autodraftBatch({ draftId, callerUserId: "lmrm-A" });
  assert(view.status === "COMPLETE", "the throwaway unlock draft completes in one autodraftBatch call");

  console.log("\n-- TM demotion waiver-exposes an 80+ GP player; LM move doesn't --");
  const vetForTm = await prisma.player.create({ data: { fullName: "Lmrm Vet TM (delete me)", primaryPosition: "L", careerNhlGp: 500 } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: vetForTm.id, callerUserId: "lmrm-A" });
  const { waiverExposed: tmExposed } = await sendToFarm({ leagueId, teamId: teamA, playerId: vetForTm.id, managerUserId: "lmrm-A" });
  assert(tmExposed, "TM-mode demotion (sendToFarm) flags an 80+ GP player as waiver-exposed");
  const tmFarmSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: vetForTm.id, slotType: "FARM", effectiveTo: null } });
  assert(!!tmFarmSlot?.waiverExpiresAt, "TM-mode demotion sets a real waiverExpiresAt on the new Farm slot");

  const vetForLm = await prisma.player.create({ data: { fullName: "Lmrm Vet LM (delete me)", primaryPosition: "R", careerNhlGp: 500 } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: vetForLm.id, callerUserId: "lmrm-A" });
  await commissionerMovePlayer({ leagueId, teamId: teamA, playerId: vetForLm.id, targetSlotType: "FARM", callerUserId: "lmrm-A" });
  const lmFarmSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: vetForLm.id, slotType: "FARM", effectiveTo: null } });
  assert(lmFarmSlot?.waiverExpiresAt === null, "LM-mode move (commissionerMovePlayer) does NOT waiver-expose the same-caliber player");

  console.log("\n-- every LM action refused for a non-commissioner caller --");
  const outsider = await prisma.player.create({ data: { fullName: "Lmrm Outsider (delete me)", primaryPosition: "C" } });
  await rejects(
    () => commissionerAddPlayer({ leagueId, teamId: teamA, playerId: outsider.id, callerUserId: "lmrm-B", targetSlotType: "ACTIVE" }),
    "commissionerAddPlayer refuses a non-commissioner caller (lmrm-B manages Team B, not the league)",
  );
  await rejects(
    () => commissionerDropPlayer({ leagueId, teamId: teamA, playerId: vetForLm.id, callerUserId: "lmrm-B" }),
    "commissionerDropPlayer refuses a non-commissioner caller",
  );
  await rejects(
    () => commissionerMovePlayer({ leagueId, teamId: teamA, playerId: vetForLm.id, targetSlotType: "ACTIVE", callerUserId: "lmrm-B" }),
    "commissionerMovePlayer refuses a non-commissioner caller",
  );

  console.log("\n-- every action refused on an ORPHAN_FROZEN team, in both modes --");
  await setTeamManager({ leagueId, teamId: teamB, callerUserId: "lmrm-A", orphan: true });
  const frozenFreeAgent = await prisma.player.create({ data: { fullName: "Lmrm Frozen Target (delete me)", primaryPosition: "D" } });
  await rejects(
    () => commissionerAddPlayer({ leagueId, teamId: teamB, playerId: frozenFreeAgent.id, callerUserId: "lmrm-A" }),
    "LM-mode add refused on an ORPHAN_FROZEN team",
  );
  await rejects(
    () => commissionerDropPlayer({ leagueId, teamId: teamB, playerId: gatedPlayer.id, callerUserId: "lmrm-A" }),
    "LM-mode drop refused on an ORPHAN_FROZEN team",
  );
  await rejects(
    () => commissionerMovePlayer({ leagueId, teamId: teamB, playerId: gatedPlayer.id, targetSlotType: "FARM", callerUserId: "lmrm-A" }),
    "LM-mode move refused on an ORPHAN_FROZEN team",
  );
  await rejects(
    () => addPlayerToRoster({ leagueId, teamId: teamB, playerId: frozenFreeAgent.id, managerUserId: "lmrm-B" }),
    "TM-mode add refused on an ORPHAN_FROZEN team",
  );
  await rejects(
    () => sendToFarm({ leagueId, teamId: teamB, playerId: gatedPlayer.id, managerUserId: "lmrm-B" }),
    "TM-mode move (sendToFarm) refused on an ORPHAN_FROZEN team",
  );

  console.log("\n-- roster view sanity --");
  const teamAView = await getTeamRosterView(teamA);
  assert(teamAView.length > 0, "getTeamRosterView returns the rows LM Roster Moves' step-2 pages render from");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lmrm-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
