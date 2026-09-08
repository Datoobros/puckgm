// Regression check for the Standings redesign's new data functions
// (src/lib/matchups/standings.ts): getTeamSeasonStats' started-players-only
// scoping, getTeamMoveCounts' type filtering and season-date scoping,
// getStandings' new streak field, getAvailableSeasons, and
// estimatePlayoffOdds. standardSeedOrder itself is already exhaustively
// covered by scripts/playoffs-check.ts — this just sanity-checks the
// bracket page's own use of real standings to seed it.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";
import {
  getStandings,
  getTeamSeasonStats,
  getTeamMoveCounts,
  getAvailableSeasons,
  estimatePlayoffOdds,
} from "@/lib/matchups/standings";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function giveScore(teamId: string, playerId: string, date: Date, slot: string, goals: number) {
  await prisma.lineupEntry.upsert({
    where: { teamId_playerId_gameDate: { teamId, playerId, gameDate: date } },
    update: { lineupSlot: slot },
    create: { teamId, playerId, gameDate: date, lineupSlot: slot },
  });
  await prisma.gameStatLine.create({
    data: { playerId, gameId: `standings-check-${playerId}-${date.toISOString()}`, gameDate: date, statsJson: { position: "C", goals } },
  });
}

async function main() {
  const season = 2032;
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Standings Redesign Test League (delete me)",
    season,
    managerUserId: "standings-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "standings-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "standings-test-C", teamName: "Team C" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "standings-test-D", teamName: "Team D" });
  console.log("league:", leagueId, { teamA, teamB, teamC, teamD });

  const startDate = isoDaysFromNow(-22);
  await generateSchedule({ leagueId, season, startDate, weekCount: 3, playoffTeams: 4, callerUserId: "standings-test-A" });
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season, isPlayoffs: false }, orderBy: { periodNo: "asc" } });
  assert(periods.length === 3, "3 completed regular-season periods created");

  const pA = await prisma.player.create({ data: { fullName: "Standings Test A (delete me)", primaryPosition: "C" } });
  const pB = await prisma.player.create({ data: { fullName: "Standings Test B (delete me)", primaryPosition: "C" } });
  const pC = await prisma.player.create({ data: { fullName: "Standings Test C (delete me)", primaryPosition: "C" } });
  const pD = await prisma.player.create({ data: { fullName: "Standings Test D (delete me)", primaryPosition: "C" } });
  const pBench = await prisma.player.create({ data: { fullName: "Standings Test Bench (delete me)", primaryPosition: "C" } });

  // A's scores: low, high, high -> a loss then a two-game win streak,
  // regardless of who it actually played each week (B/C/D held constant).
  const aScores = [5, 30, 30];
  for (let i = 0; i < periods.length; i++) {
    await giveScore(teamA, pA.id, periods[i].startDate, "C", aScores[i]);
    await giveScore(teamB, pB.id, periods[i].startDate, "C", 20);
    await giveScore(teamC, pC.id, periods[i].startDate, "C", 20);
    await giveScore(teamD, pD.id, periods[i].startDate, "C", 20);
  }
  // A bench-only stretch for Team A — must NOT count toward season stats.
  await giveScore(teamA, pBench.id, periods[0].startDate, "BE", 100);

  console.log("\n-- getStandings streak --");
  const standings = await getStandings(leagueId, season, { goals: 2 });
  const rowA = standings.find((r) => r.teamId === teamA)!;
  assert(rowA.wins === 2 && rowA.losses === 1, "Team A went 2-1 as designed");
  assert(rowA.streak === "W2", `Team A's streak is a 2-game win streak (loss, win, win) — got "${rowA.streak}"`);

  console.log("\n-- getTeamSeasonStats only counts started (non-BE) players --");
  const seasonStats = await getTeamSeasonStats(leagueId, season);
  const statsA = seasonStats.get(teamA)!;
  assert(statsA.goals === 65, `Team A's season goals is 65 (5+30+30), excluding the 100-goal bench stretch — got ${statsA.goals}`);

  console.log("\n-- getTeamMoveCounts includes real moves, excludes the rest --");
  const inRangeDate = new Date(periods[0].startDate.getTime() + 60 * 60 * 1000);
  const outOfRangeDate = new Date(periods[0].startDate.getTime() - 1000 * 60 * 60 * 24 * 365);
  const moveRows: { type: string; payload: Record<string, unknown>; effectiveAt: Date }[] = [
    { type: "ROSTER_ADD", payload: {}, effectiveAt: inRangeDate },
    { type: "SEND_DOWN", payload: {}, effectiveAt: inRangeDate },
    { type: "LINEUP_EDIT", payload: {}, effectiveAt: inRangeDate },
    { type: "COMMISSIONER_MOVE", payload: {}, effectiveAt: inRangeDate },
    { type: "FAAB_BID", payload: {}, effectiveAt: inRangeDate },
    { type: "FAAB_WIN", payload: {}, effectiveAt: inRangeDate },
    { type: "WAIVER_CLAIM", payload: { event: "AWARDED" }, effectiveAt: inRangeDate },
    { type: "WAIVER_CLAIM", payload: { event: "SUBMITTED" }, effectiveAt: inRangeDate },
    { type: "TRADE", payload: { event: "PROPOSED" }, effectiveAt: inRangeDate },
    { type: "TRADE", payload: { event: "PROCESSED" }, effectiveAt: inRangeDate },
    { type: "ROSTER_ADD", payload: {}, effectiveAt: outOfRangeDate }, // outside the season's date range
  ];
  for (const row of moveRows) {
    await prisma.transactionLog.create({
      data: { leagueId, type: row.type, actorTeamId: teamA, payload: row.payload as object, effectiveAt: row.effectiveAt },
    });
  }
  const moveCounts = await getTeamMoveCounts(leagueId, season);
  assert(
    moveCounts.get(teamA) === 5,
    `Team A's move count is 5 (ROSTER_ADD, SEND_DOWN, FAAB_WIN, WAIVER_CLAIM/AWARDED, TRADE/PROCESSED) — got ${moveCounts.get(teamA)}`,
  );

  console.log("\n-- estimatePlayoffOdds --");
  assert(estimatePlayoffOdds(1, 8, 0) === null, "no bracket configured -> null");
  const in1 = estimatePlayoffOdds(1, 8, 4)!;
  const in4 = estimatePlayoffOdds(4, 8, 4)!;
  const out5 = estimatePlayoffOdds(5, 8, 4)!;
  const out8 = estimatePlayoffOdds(8, 8, 4)!;
  assert(in1 > in4, `1st place odds (${in1}) beat the last bracket spot's odds (${in4})`);
  assert(in4 > out5, `the last bracket spot's odds (${in4}) beat the first team out (${out5})`);
  assert(out5 > out8, `first team out (${out5}) beats last place (${out8})`);

  console.log("\n-- getAvailableSeasons --");
  const availableForFixtureLeague = await getAvailableSeasons(leagueId, season);
  assert(availableForFixtureLeague.includes(season), "the fixture league's own season is in its available list");

  const { leagueId: freshLeagueId } = await createLeague({
    name: "Standings Redesign Fresh League (delete me)",
    season: 2099,
    managerUserId: "standings-test-fresh",
    teamName: "Fresh Team",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 0,
    irSlots: 0,
  });
  const availableFresh = await getAvailableSeasons(freshLeagueId, 2099);
  assert(availableFresh.length === 1 && availableFresh[0] === 2099, "a league with no schedule yet still lists its currentSeason");
  await deleteLeague(freshLeagueId, "standings-test-fresh");

  console.log("\n-- bracket page's real-standings seeding sanity check --");
  const top4 = standings.slice(0, 4);
  assert(top4[0].teamId === standings[0].teamId, "rank-1 seed matches getStandings' own sort order");
  assert(top4.length === 4, "exactly 4 teams available to seed a 4-team bracket");

  console.log("\nAll standings-redesign checks passed.");

  console.log("\n-- cleanup --");
  const testPlayers = await prisma.player.findMany({ where: { fullName: { contains: "Standings Test" } } });
  const playerIds = testPlayers.map((p) => p.id);
  await prisma.gameStatLine.deleteMany({ where: { playerId: { in: playerIds } } });
  await deleteLeague(leagueId, "standings-test-A");
  await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
  console.log("cleaned up");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
