import { prisma } from "@/lib/db";
import { createLeague, createTeam, updateLeagueSettings, getLeague, deleteLeague } from "@/lib/leagues/mutations";
import { addPlayerToRoster, getTeamRosterView } from "@/lib/rosters/mutations";
import { submitFaBid, cancelFaBid, getAvailableBudget, processFaabBids, getMyPendingBids } from "@/lib/faab/mutations";

const LEAGUE_SEASON = 2027; // must match the `season` passed to createLeague below — this is now per-league, not a global constant

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "FAAB Test League (delete me)",
    season: LEAGUE_SEASON,
    managerUserId: "faab-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "faab-test-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  const fixture = await prisma.player.create({ data: { fullName: "FAAB Test Free Agent (delete me)", primaryPosition: "C" } });

  console.log("\n-- with FAAB off, instant add still works (no regression) --");
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: fixture.id, managerUserId: "faab-test-A" });
  const rosterAfterInstantAdd = await getTeamRosterView(teamA);
  assert(rosterAfterInstantAdd.some((s) => s.playerId === fixture.id), "instant add works when faabEnabled is false");
  await prisma.rosterSlot.updateMany({ where: { teamId: teamA, playerId: fixture.id }, data: { effectiveTo: new Date() } });

  console.log("\n-- enable FAAB --");
  await updateLeagueSettings({
    leagueId,
    callerUserId: "faab-test-A",
    farmSlots: 4,
    irSlots: 2,
    waiverGpThreshold: 80,
    callupsPerWeek: 2,
    scoringConfig: {},
    faabEnabled: true,
    faabBudget: 100,
    faabMinBid: 2,
    faabMaxBid: 60,
    tradeVetoMode: "COMMISSIONER",
    tradeDeadline: null,
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    draftPickTradingEnabled: true,
  });

  let threw = false;
  try {
    await addPlayerToRoster({ leagueId, teamId: teamA, playerId: fixture.id, managerUserId: "faab-test-A" });
  } catch {
    threw = true;
  }
  assert(threw, "instant add now throws once FAAB is enabled");

  console.log("\n-- min/max bid enforcement --");
  let minThrew = false;
  try {
    await submitFaBid({ leagueId, playerId: fixture.id, amount: 1, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  } catch {
    minThrew = true;
  }
  assert(minThrew, "bid below minimum throws");

  let maxThrew = false;
  try {
    await submitFaBid({ leagueId, playerId: fixture.id, amount: 61, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  } catch {
    maxThrew = true;
  }
  assert(maxThrew, "bid above maximum throws");

  console.log("\n-- available budget blocks overcommitted simultaneous bids --");
  const fixture2 = await prisma.player.create({ data: { fullName: "FAAB Test Free Agent 2 (delete me)", primaryPosition: "D" } });
  await submitFaBid({ leagueId, playerId: fixture.id, amount: 50, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  const availableAfterFirstBid = await getAvailableBudget(teamA, LEAGUE_SEASON, 100);
  assert(availableAfterFirstBid === 50, "available budget drops by the pending bid amount (100 - 50 = 50)");

  let overCommitThrew = false;
  try {
    await submitFaBid({ leagueId, playerId: fixture2.id, amount: 60, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  } catch {
    overCommitThrew = true;
  }
  assert(overCommitThrew, "a second simultaneous bid exceeding available (not just remaining) budget throws");

  console.log("\n-- Team B outbids Team A on the same free agent --");
  await submitFaBid({ leagueId, playerId: fixture.id, amount: 55, targetSlot: "FARM", managerUserId: "faab-test-B" });

  const results = await processFaabBids();
  const winResult = results.find((r) => r.playerId === fixture.id);
  console.log("process result:", winResult);
  assert(winResult?.outcome === "WON" && winResult.awardedToTeamId === teamB, "Team B's higher bid wins");

  const rosterBAfter = await getTeamRosterView(teamB);
  const farmSlot = rosterBAfter.find((s) => s.playerId === fixture.id && s.slotType === "FARM");
  assert(!!farmSlot, "the player landed on Team B's FARM roster, matching the winning bid's targetSlot");

  const league = await getLeague(leagueId);
  const budgetB = await prisma.faabBudget.findUnique({ where: { teamId_season: { teamId: teamB, season: LEAGUE_SEASON } } });
  assert(budgetB?.remaining === 45, "Team B's budget debited by the winning amount (100 - 55 = 45)");
  const budgetA = await prisma.faabBudget.findUnique({ where: { teamId_season: { teamId: teamA, season: LEAGUE_SEASON } } });
  assert(budgetA?.remaining === 100, "Team A's losing bid didn't touch its remaining budget");
  assert(!!league, "league still exists"); // keep `league` referenced

  const bidA = await prisma.faBid.findFirst({ where: { teamId: teamA, playerId: fixture.id } });
  assert(bidA?.result === "LOST", "Team A's losing bid is marked LOST");

  console.log("\n-- cancel before processing --");
  const fixture3 = await prisma.player.create({ data: { fullName: "FAAB Test Free Agent 3 (delete me)", primaryPosition: "G" } });
  await submitFaBid({ leagueId, playerId: fixture3.id, amount: 10, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  const pendingBefore = await getMyPendingBids(leagueId, teamA);
  const bidToCancel = pendingBefore.find((b) => b.playerId === fixture3.id);
  assert(!!bidToCancel, "the bid shows up in getMyPendingBids");
  await cancelFaBid({ bidId: bidToCancel!.id, managerUserId: "faab-test-A" });
  const availableAfterCancel = await getAvailableBudget(teamA, LEAGUE_SEASON, 100);
  assert(availableAfterCancel === 100, "cancelling restores full available budget (nothing was ever debited)");

  console.log("\n-- overflow: winning bid bypasses the active roster cap --");
  for (let i = 0; i < 8; i++) {
    const filler = await prisma.player.create({ data: { fullName: `FAAB Filler ${i} (delete me)`, primaryPosition: "C" } });
    await prisma.rosterSlot.create({ data: { teamId: teamA, playerId: filler.id, slotType: "ACTIVE" } });
  }
  const rosterAFull = await getTeamRosterView(teamA);
  assert(rosterAFull.filter((s) => s.slotType === "ACTIVE").length === 8, "Team A's active roster is at cap (8)");
  const fixture4 = await prisma.player.create({ data: { fullName: "FAAB Test Free Agent 4 (delete me)", primaryPosition: "D" } });
  await submitFaBid({ leagueId, playerId: fixture4.id, amount: 5, targetSlot: "ACTIVE", managerUserId: "faab-test-A" });
  await processFaabBids();
  const rosterAOverflow = await getTeamRosterView(teamA);
  const activeAOverflow = rosterAOverflow.filter((s) => s.slotType === "ACTIVE");
  assert(activeAOverflow.length === 9, "winning bid overflowed Team A's active roster to 9 (cap bypass)");

  console.log("\n-- cleanup (via the real deleteLeague, exercising its FaBid/FaabBudget fix) --");
  const players = await prisma.player.findMany({ where: { fullName: { contains: "FAAB Test" } } });
  const fillers = await prisma.player.findMany({ where: { fullName: { contains: "FAAB Filler" } } });
  const allPlayerIds = [...players.map((p) => p.id), ...fillers.map((p) => p.id)];
  await deleteLeague(leagueId, "faab-test-A");
  await prisma.player.deleteMany({ where: { id: { in: allPlayerIds } } });
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
