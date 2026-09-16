// One-off seed/cleanup script for verifying Task 2 (team header restructure +
// Notifications modal, plans/team-page-batch.md) in a real browser. Creates a
// disposable 3-team league — NOT the user's real "Experimenting" league —
// with a pending trade so one team has a "needs your response" notification
// and another has zero, matching the plan's verification section. Named
// distinctly and cleaned up by exact name, per PROGRESS.md's shared-database
// convention (same pattern as scripts/trades-check.ts).
//
// Usage:
//   npx tsx scripts/header-modal-test-league.ts            # seed
//   npx tsx scripts/header-modal-test-league.ts --cleanup   # delete by exact name

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { addPlayerToRoster } from "@/lib/rosters/mutations";
import { proposeTrade } from "@/lib/trades/mutations";

const LEAGUE_NAME = "Header Modal Test League (delete me)";
const LEAGUE_SEASON = 2027;

async function cleanup() {
  const league = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (!league) {
    console.log("nothing to clean up — no league named", JSON.stringify(LEAGUE_NAME));
    return;
  }
  const fixturePlayers = await prisma.player.findMany({ where: { fullName: { contains: "Header Modal Test" } } });
  const fixtureIds = fixturePlayers.map((p) => p.id);
  const firstTeam = await prisma.team.findFirst({ where: { leagueId: league.id }, orderBy: { createdAt: "asc" } });
  await deleteLeague(league.id, league.commissionerUserId ?? firstTeam?.managerUserId ?? "header-modal-test-A");
  if (fixtureIds.length > 0) await prisma.player.deleteMany({ where: { id: { in: fixtureIds } } });
  console.log("deleted league:", LEAGUE_NAME, league.id, "and", fixtureIds.length, "fixture player(s)");
}

async function seed() {
  const existing = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (existing) {
    console.log("already seeded — league:", existing.id, "(run with --cleanup first to reseed)");
    return;
  }

  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: LEAGUE_SEASON,
    managerUserId: "header-modal-test-A",
    teamName: "Proposer (Team A)",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "header-modal-test-B", teamName: "Counterparty (Team B)" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "header-modal-test-C", teamName: "Bystander (Team C)" });

  const tradeBait = await prisma.player.create({
    data: { fullName: "Header Modal Test Bait (delete me)", primaryPosition: "C", careerNhlGp: 50 },
  });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: tradeBait.id, managerUserId: "header-modal-test-A" });

  // One roster filler each for B and C so the action bar's "− Drop" two-step
  // confirm has an actual occupant row to click through in the browser check.
  const rosterFillerB = await prisma.player.create({
    data: { fullName: "Header Modal Test RosterB (delete me)", primaryPosition: "D", careerNhlGp: 10 },
  });
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: rosterFillerB.id, managerUserId: "header-modal-test-B" });
  const rosterFillerC = await prisma.player.create({
    data: { fullName: "Header Modal Test RosterC (delete me)", primaryPosition: "D", careerNhlGp: 10 },
  });
  await addPlayerToRoster({ leagueId, teamId: teamC, playerId: rosterFillerC.id, managerUserId: "header-modal-test-C" });

  const { tradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamB,
    managerUserId: "header-modal-test-A",
    give: { playerIds: [tradeBait.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });

  console.log("seeded league:", leagueId);
  console.log("tradeId:", tradeId);
  console.log("teamA (Proposer, manager header-modal-test-A) — expect 'TRADE_PENDING' notification:", teamA);
  console.log("teamB (Counterparty, manager header-modal-test-B) — expect 'needs your response' notification (Notifications (1)):", teamB);
  console.log("teamC (Bystander, manager header-modal-test-C) — expect ZERO notifications (Notifications (0)):", teamC);
  console.log("\nBrowser check URLs (with a matching // TEMP: userId bypass):");
  console.log(`  /leagues/${leagueId}/teams/${teamB}   (userId = header-modal-test-B)`);
  console.log(`  /leagues/${leagueId}/teams/${teamC}   (userId = header-modal-test-C)`);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
  } else {
    await seed();
  }
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
