import { prisma } from "@/lib/db";
import { createLeague, createTeam, getLeague, listLeagues } from "@/lib/leagues/mutations";

async function main() {
  console.log("-- creating a league --");
  const { leagueId, teamId } = await createLeague({
    name: "Test League (delete me)",
    season: 2027,
    managerUserId: "test-user-1",
    teamName: "Test Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  console.log("created league:", leagueId, "team:", teamId);

  console.log("\n-- second manager joins --");
  const { teamId: teamId2 } = await createTeam({
    leagueId,
    managerUserId: "test-user-2",
    teamName: "Test Team B",
  });
  console.log("joined as team:", teamId2);

  console.log("\n-- duplicate join attempt (should throw) --");
  try {
    await createTeam({ leagueId, managerUserId: "test-user-1", teamName: "Sneaky second team" });
    console.log("FAIL: duplicate join was not blocked");
  } catch (e) {
    console.log("correctly blocked:", e instanceof Error ? e.message : e);
  }

  console.log("\n-- fetch league detail --");
  const league = await getLeague(leagueId);
  console.log(JSON.stringify(league, null, 2));

  console.log("\n-- list leagues --");
  const all = await listLeagues();
  console.log(`${all.length} league(s) total`);

  console.log("\n-- cleanup --");
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  console.log("cleaned up test league");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
