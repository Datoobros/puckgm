import { prisma } from "@/lib/db";
import { createLeague, createTeam } from "@/lib/leagues/mutations";
import { addPlayerToRoster, sendToFarm, callUpToActive, getTeamRosterView } from "@/lib/rosters/mutations";
import {
  getClaimablePlayers,
  getOrInitWaiverPriority,
  submitWaiverClaim,
  processExpiredWaivers,
} from "@/lib/waivers/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Waiver Claim Test League (delete me)",
    season: 2027,
    managerUserId: "waiver-test-A",
    teamName: "Team A",
    rosterComposition: { C: 1, LW: 1, RW: 1, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "waiver-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "waiver-test-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  const fixture = await prisma.player.create({
    data: { fullName: "Waiver Test Vet (delete me)", primaryPosition: "C", careerNhlGp: 400 },
  });
  const other = await prisma.player.create({
    data: { fullName: "Waiver Test Rookie (delete me)", primaryPosition: "C", careerNhlGp: 10 },
  });

  console.log("\n-- priority seed (reverse team-creation order) --");
  const seeded = await getOrInitWaiverPriority(leagueId);
  console.log("seeded order:", seeded);
  assert(seeded[0] === teamC && seeded[1] === teamB && seeded[2] === teamA, "seeded order is [C, B, A] (last created first)");

  console.log("\n-- demote an 80+ GP player from Team A --");
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: fixture.id, managerUserId: "waiver-test-A" });
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamA, playerId: fixture.id, managerUserId: "waiver-test-A" });
  assert(waiverExposed === true, "400-GP player is waiver-exposed on demotion");

  const claimableForB = await getClaimablePlayers(leagueId, teamB);
  assert(claimableForB.length === 1 && claimableForB[0].playerId === fixture.id, "Team B sees him as claimable");

  console.log("\n-- can't claim your own demotion --");
  let threw = false;
  try {
    await submitWaiverClaim({ leagueId, playerId: fixture.id, managerUserId: "waiver-test-A" });
  } catch {
    threw = true;
  }
  assert(threw, "Team A claiming its own drop throws");

  console.log("\n-- Team B and Team C both claim him; fill Team C's active roster to cap first --");
  // rosterComposition sums to 8 (C1+LW1+RW1+D1+G1+UTIL1+BENCH2) — that's the active cap.
  for (let i = 0; i < 8; i++) {
    const filler = await prisma.player.create({ data: { fullName: `Waiver Filler ${i} (delete me)`, primaryPosition: "C" } });
    await addPlayerToRoster({ leagueId, teamId: teamC, playerId: filler.id, managerUserId: "waiver-test-C" });
  }
  const rosterC = await getTeamRosterView(teamC);
  assert(rosterC.filter((s) => s.slotType === "ACTIVE").length === 8, "Team C's active roster is at cap (8)");

  await submitWaiverClaim({ leagueId, playerId: fixture.id, managerUserId: "waiver-test-B" });
  await submitWaiverClaim({ leagueId, playerId: fixture.id, managerUserId: "waiver-test-C" });

  console.log("\n-- backdate the window and process --");
  await prisma.rosterSlot.updateMany({
    where: { playerId: fixture.id, slotType: "FARM", effectiveTo: null },
    data: { waiverExpiresAt: new Date(Date.now() - 1000) },
  });
  const results = await processExpiredWaivers();
  const fixtureResult = results.find((r) => r.playerId === fixture.id);
  console.log("process result:", fixtureResult);
  assert(fixtureResult?.outcome === "AWARDED" && fixtureResult.awardedToTeamId === teamC, "Team C (higher priority) wins despite a full active roster");

  const claimsAfter = await prisma.waiverClaim.findMany({ where: { playerId: fixture.id } });
  const bClaim = claimsAfter.find((c) => c.teamId === teamB);
  const cClaim = claimsAfter.find((c) => c.teamId === teamC);
  assert(bClaim?.result === "CLEARED", "Team B's losing claim is CLEARED");
  assert(cClaim?.result === "AWARDED", "Team C's winning claim is AWARDED");

  const rosterCAfter = await getTeamRosterView(teamC);
  const activeCAfter = rosterCAfter.filter((s) => s.slotType === "ACTIVE");
  assert(activeCAfter.length === 9, "Team C's active roster overflowed to 9 (cap bypass on award)");
  assert(activeCAfter.some((s) => s.playerId === fixture.id), "the claimed player landed on Team C's ACTIVE roster");

  const rotated = await getOrInitWaiverPriority(leagueId);
  assert(rotated[rotated.length - 1] === teamC, "Team C rotated to the back of the priority queue");

  console.log("\n-- no re-exposure penalty within 48h of being claimed --");
  const { waiverExposed: reExposed } = await sendToFarm({ leagueId, teamId: teamC, playerId: fixture.id, managerUserId: "waiver-test-C" });
  assert(reExposed === false, "sending him right back down doesn't re-flag waiverExposed");
  const farmSlotAfter = await prisma.rosterSlot.findFirst({ where: { playerId: fixture.id, slotType: "FARM", effectiveTo: null } });
  assert(farmSlotAfter?.waiverExpiresAt === null, "no new claim window opened for the exempt re-demotion");

  console.log("\n-- callup preempts a pending claim --");
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: other.id, managerUserId: "waiver-test-A" });
  await sendToFarm({ leagueId, teamId: teamA, playerId: other.id, managerUserId: "waiver-test-A" });
  // 10 GP player isn't waiver-exposed, so force a window open for this test.
  await prisma.rosterSlot.updateMany({
    where: { playerId: other.id, slotType: "FARM", effectiveTo: null },
    data: { waiverExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  await submitWaiverClaim({ leagueId, playerId: other.id, managerUserId: "waiver-test-B" });
  await callUpToActive({ leagueId, teamId: teamA, playerId: other.id, managerUserId: "waiver-test-A" });
  const otherClaim = await prisma.waiverClaim.findFirst({ where: { playerId: other.id } });
  assert(otherClaim?.result === "CLEARED", "a callup before expiry voids the pending claim");

  console.log("\n-- organic clear (no claims at all) --");
  const noClaimPlayer = await prisma.player.create({ data: { fullName: "Waiver Test Unclaimed (delete me)", primaryPosition: "D", careerNhlGp: 500 } });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: noClaimPlayer.id, managerUserId: "waiver-test-A" });
  await sendToFarm({ leagueId, teamId: teamA, playerId: noClaimPlayer.id, managerUserId: "waiver-test-A" });
  await prisma.rosterSlot.updateMany({
    where: { playerId: noClaimPlayer.id, slotType: "FARM", effectiveTo: null },
    data: { waiverExpiresAt: new Date(Date.now() - 1000) },
  });
  const results2 = await processExpiredWaivers();
  const uncl = results2.find((r) => r.playerId === noClaimPlayer.id);
  assert(uncl?.outcome === "EXPIRED_UNCLAIMED", "unclaimed player clears organically");
  const stillFarm = await prisma.rosterSlot.findFirst({ where: { playerId: noClaimPlayer.id, slotType: "FARM", effectiveTo: null } });
  assert(!!stillFarm && stillFarm.waiverExpiresAt === null, "he stays on Team A's farm, just no longer claimable");

  console.log("\n-- cleanup --");
  const playerIds = [fixture.id, other.id, noClaimPlayer.id];
  const fillers = await prisma.player.findMany({ where: { fullName: { contains: "Waiver Filler" } } });
  playerIds.push(...fillers.map((p) => p.id));
  await prisma.waiverClaim.deleteMany({ where: { playerId: { in: playerIds } } });
  await prisma.transactionLog.deleteMany({ where: { leagueId } });
  await prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } });
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
