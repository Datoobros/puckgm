import { prisma } from "@/lib/db";
import { createLeague, deleteLeague, getLeagueCommissioner } from "@/lib/leagues/mutations";

async function main() {
  const { leagueId } = await createLeague({
    name: "Delete Test League (delete me)",
    season: 2027,
    managerUserId: "delete-test-owner",
    teamName: "Owner Team",
    rosterComposition: { C: 2, LW: 2, RW: 2, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });

  const commissioner = await getLeagueCommissioner(leagueId);
  console.log("commissioner:", commissioner);

  console.log("\n-- wrong user tries to delete (should be blocked) --");
  try {
    await deleteLeague(leagueId, "not-the-commissioner");
    console.log("FAIL: unauthorized delete succeeded");
  } catch (e) {
    console.log("correctly blocked:", e instanceof Error ? e.message : e);
  }

  const stillExists = await prisma.league.findUnique({ where: { id: leagueId } });
  console.log("league still exists after blocked attempt:", !!stillExists);

  console.log("\n-- correct commissioner deletes --");
  await deleteLeague(leagueId, "delete-test-owner");
  const goneNow = await prisma.league.findUnique({ where: { id: leagueId } });
  console.log("league exists after real delete:", !!goneNow);

  console.log("\n-- legacy-league fallback (null commissionerUserId) --");
  const { leagueId: legacyLeagueId, teamId: legacyTeamId } = await createLeague({
    name: "Legacy Fallback Test League (delete me)",
    season: 2027,
    managerUserId: "legacy-owner",
    teamName: "Legacy Team",
    rosterComposition: { C: 2, LW: 2, RW: 2, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  // Simulate a pre-migration league by nulling out the field directly.
  await prisma.league.update({ where: { id: legacyLeagueId }, data: { commissionerUserId: null } });
  const inferredCommissioner = await getLeagueCommissioner(legacyLeagueId);
  console.log("inferred commissioner (from earliest team):", inferredCommissioner, "expected: legacy-owner");
  await deleteLeague(legacyLeagueId, "legacy-owner");
  const legacyGone = await prisma.league.findUnique({ where: { id: legacyLeagueId } });
  console.log("legacy league deleted via fallback:", !legacyGone);
  void legacyTeamId;
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
