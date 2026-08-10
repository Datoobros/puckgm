import { prisma } from "@/lib/db";
import { createLeague, createTeam } from "@/lib/leagues/mutations";
import { addPlayerToRoster, dropPlayerFromRoster, getTeamRosterView } from "@/lib/rosters/mutations";

async function main() {
  console.log("-- setup: tiny league, 1-slot cap, two teams --");
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Roster Test League (delete me)",
    season: 2027,
    managerUserId: "roster-test-1",
    teamName: "Team A",
    // Deliberately tiny cap (sum = 1) to exercise the full-roster path fast.
    rosterComposition: { C: 1, LW: 0, RW: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({
    leagueId,
    managerUserId: "roster-test-2",
    teamName: "Team B",
  });
  console.log("league:", leagueId, "teamA:", teamA, "teamB:", teamB);

  const [mcdavid, ovechkin] = await prisma.player.findMany({
    where: { fullName: { in: ["Connor McDavid", "Alex Ovechkin"] } },
  });
  console.log("using players:", mcdavid?.fullName, ovechkin?.fullName);

  console.log("\n-- Team A adds McDavid (should succeed) --");
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: mcdavid.id, managerUserId: "roster-test-1" });
  console.log("ok");

  console.log("\n-- Team B tries to add McDavid too (should be blocked - exclusivity) --");
  try {
    await addPlayerToRoster({ leagueId, teamId: teamB, playerId: mcdavid.id, managerUserId: "roster-test-2" });
    console.log("FAIL: exclusivity not enforced");
  } catch (e) {
    console.log("correctly blocked:", e instanceof Error ? e.message : e);
  }

  console.log("\n-- Team A tries to add Ovechkin too (should be blocked - roster cap of 1) --");
  try {
    await addPlayerToRoster({ leagueId, teamId: teamA, playerId: ovechkin.id, managerUserId: "roster-test-1" });
    console.log("FAIL: roster cap not enforced");
  } catch (e) {
    console.log("correctly blocked:", e instanceof Error ? e.message : e);
  }

  console.log("\n-- Team B tries to manage Team A's roster (should be blocked - not the manager) --");
  try {
    await dropPlayerFromRoster({ teamId: teamA, playerId: mcdavid.id, managerUserId: "roster-test-2" });
    console.log("FAIL: manager check not enforced");
  } catch (e) {
    console.log("correctly blocked:", e instanceof Error ? e.message : e);
  }

  console.log("\n-- Team A drops McDavid --");
  await dropPlayerFromRoster({ teamId: teamA, playerId: mcdavid.id, managerUserId: "roster-test-1" });
  const rosterAfterDrop = await getTeamRosterView(teamA);
  console.log("Team A roster after drop:", rosterAfterDrop.length, "players");

  console.log("\n-- Team B can now add McDavid (freed up by the drop) --");
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: mcdavid.id, managerUserId: "roster-test-2" });
  const teamBRoster = await getTeamRosterView(teamB);
  console.log("Team B roster:", teamBRoster.map((s) => s.player.fullName));

  console.log("\n-- TransactionLog entries written --");
  const log = await prisma.transactionLog.findMany({ where: { leagueId }, orderBy: { createdAt: "asc" } });
  console.log(log.map((l) => `${l.type} by ${l.actorTeamId}: ${JSON.stringify(l.payload)}`));

  console.log("\n-- cleanup --");
  await prisma.transactionLog.deleteMany({ where: { leagueId } });
  await prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } });
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  console.log("cleaned up");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
