// Regression check for LM Tools batch Task 5's Edit Waiver Order —
// setWaiverPriority itself, plus proof that rotatePriorityToBack (private,
// fired when a claim is actually awarded) still rotates correctly on top of
// a manually-set order rather than some earlier seeded one.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { commissionerAddPlayer, sendToFarm } from "@/lib/rosters/mutations";
import { setUpDraft, startDraft, autodraftBatch } from "@/lib/draft/mutations";
import { getOrInitWaiverPriority, setWaiverPriority, submitWaiverClaim, processExpiredWaivers } from "@/lib/waivers/mutations";

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
    name: "LM Waiver Order Test League (delete me)",
    season: 2031,
    managerUserId: "lmwo-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lmwo-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "lmwo-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  console.log("\n-- setWaiverPriority sets a new order --");
  const newOrder = [teamB, teamC, teamA];
  await setWaiverPriority({ leagueId, orderedTeamIds: newOrder, callerUserId: "lmwo-A" });
  const stored = await getOrInitWaiverPriority(leagueId);
  assert(JSON.stringify(stored) === JSON.stringify(newOrder), `getOrInitWaiverPriority returns the order just set (got ${JSON.stringify(stored)})`);

  console.log("\n-- a missing id is rejected --");
  await rejects(
    () => setWaiverPriority({ leagueId, orderedTeamIds: [teamB, teamC], callerUserId: "lmwo-A" }),
    "an order missing a team is rejected",
  );

  console.log("\n-- a duplicate id is rejected --");
  await rejects(
    () => setWaiverPriority({ leagueId, orderedTeamIds: [teamB, teamB, teamC], callerUserId: "lmwo-A" }),
    "an order with a duplicate team is rejected",
  );
  const unchanged = await getOrInitWaiverPriority(leagueId);
  assert(JSON.stringify(unchanged) === JSON.stringify(newOrder), "a rejected submission left the stored order untouched");

  console.log("\n-- refused for a non-commissioner caller --");
  await rejects(
    () => setWaiverPriority({ leagueId, orderedTeamIds: [teamC, teamB, teamA], callerUserId: "lmwo-B" }),
    "a non-commissioner caller is refused",
  );

  console.log("\n-- opening free agency (throwaway 1-round draft), needed for a real claim --");
  const { draftId } = await setUpDraft({
    leagueId, season: 2020, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC], pickTimerSeconds: 600, callerUserId: "lmwo-A",
  });
  await startDraft({ draftId, callerUserId: "lmwo-A" });
  const view = await autodraftBatch({ draftId, callerUserId: "lmwo-A" });
  assert(view.status === "COMPLETE", "the throwaway unlock draft completes in one autodraftBatch call");

  console.log("\n-- an awarded claim rotates the winner to the back, on top of the manual order --");
  // Order going in: [B, C, A]. Team A demotes a vet; both B and C claim him.
  // B has top priority in the current order, so B should win and end up at
  // the back: [C, A, B].
  const vet = await prisma.player.create({ data: { fullName: "Lmwo Vet (delete me)", primaryPosition: "C", careerNhlGp: 500 } });
  await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: vet.id, callerUserId: "lmwo-A" });
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamA, playerId: vet.id, managerUserId: "lmwo-A" });
  assert(waiverExposed, "the 500-GP player is waiver-exposed on demotion");

  await submitWaiverClaim({ leagueId, playerId: vet.id, managerUserId: "lmwo-B" });
  await submitWaiverClaim({ leagueId, playerId: vet.id, managerUserId: "lmwo-C" });

  await prisma.rosterSlot.updateMany({
    where: { teamId: teamA, playerId: vet.id, slotType: "FARM", effectiveTo: null },
    data: { waiverExpiresAt: new Date(Date.now() - 1000) },
  });
  const results = await processExpiredWaivers();
  const outcome = results.find((r) => r.playerId === vet.id);
  assert(outcome?.outcome === "AWARDED" && outcome.awardedToTeamId === teamB, `Team B (top priority) wins the contested claim (got ${JSON.stringify(outcome)})`);

  const afterAward = await getOrInitWaiverPriority(leagueId);
  assert(JSON.stringify(afterAward) === JSON.stringify([teamC, teamA, teamB]), `the winner (B) rotated to the back of the manually-set order, got ${JSON.stringify(afterAward)}`);

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lmwo-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
