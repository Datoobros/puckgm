// Deletes leftover test leagues by exact name, keeping every other league
// (in particular "Experimenting", the real shared-prod league) completely
// untouched. Every child table here has a real FK constraint back to League
// or Team with no cascade configured (see prisma/schema.prisma) — this is
// the same deletion order as src/lib/leagues/mutations.ts's deleteLeague,
// duplicated here rather than imported because deleteLeague requires a
// commissioner userId and this is a maintenance script, not a user action.
import { prisma } from "@/lib/db";

const TEST_LEAGUE_NAMES = [
  "Test Draft League",
  "Draft Test League (delete me)",
  "QoL Batch Test League (delete me)",
  "Co-Manager Test League (delete me)",
  "Draft Autodraft Test League (delete me)",
];

async function deleteLeagueCascade(leagueId: string) {
  await prisma.$transaction([
    prisma.scoreAdjustment.deleteMany({ where: { leagueId } }),
    prisma.matchup.deleteMany({ where: { matchupPeriod: { leagueId } } }),
    prisma.matchupPeriod.deleteMany({ where: { leagueId } }),
    prisma.leagueSettingsLog.deleteMany({ where: { leagueId } }),
    prisma.transactionLog.deleteMany({ where: { leagueId } }),
    prisma.watchlistEntry.deleteMany({ where: { leagueId } }),
    prisma.faBid.deleteMany({ where: { team: { leagueId } } }),
    prisma.faabBudget.deleteMany({ where: { team: { leagueId } } }),
    prisma.waiverClaim.deleteMany({ where: { team: { leagueId } } }),
    prisma.tradeVeto.deleteMany({ where: { trade: { leagueId } } }),
    prisma.tradeItem.deleteMany({ where: { trade: { leagueId } } }),
    prisma.trade.deleteMany({ where: { leagueId } }),
    prisma.draftPick.deleteMany({ where: { leagueId } }),
    prisma.draft.deleteMany({ where: { leagueId } }),
    prisma.lineupEntry.deleteMany({ where: { team: { leagueId } } }),
    prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } }),
    prisma.team.deleteMany({ where: { leagueId } }),
    prisma.league.delete({ where: { id: leagueId } }),
  ]);
}

async function main() {
  const testLeagues = await prisma.league.findMany({
    where: { name: { in: TEST_LEAGUE_NAMES } },
  });
  if (testLeagues.some((l) => l.name === "Experimenting")) {
    throw new Error("refusing to run: 'Experimenting' matched the test-league name filter");
  }
  for (const league of testLeagues) {
    await deleteLeagueCascade(league.id);
    console.log("deleted:", league.name, league.id);
  }
  console.log(`deleted ${testLeagues.length} leagues`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
