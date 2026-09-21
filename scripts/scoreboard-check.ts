// Regression check for the Scoreboard redesign's data layer
// (src/lib/matchups/standings.ts): getTeamPeriodPlayerPoints' started-players
// scope (BE excluded), its 0.0-for-started-but-scoreless behavior, and its
// sort (real points desc, then career-points tie-break, then name);
// getTeamTopScorersForPeriod as a thin slice/map over the same data; that a
// team's total PeriodPlayerPoints always equals getTeamScoreForPeriod for
// the same range (the scoreboard's card and its top-scorers column must
// never disagree with the score itself); and (Task 2) that getMatchupDetail
// agrees with the scoreboard on both teams' totals and rejects a matchup id
// that doesn't exist.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";
import {
  getTeamPeriodPlayerPoints,
  getTeamTopScorersForPeriod,
  getTeamScoreForPeriod,
  getMatchupDetail,
} from "@/lib/matchups/standings";

const SCORING = { goals: 2 };

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const season = 2033;
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Scoreboard Test League (delete me)",
    season,
    managerUserId: "scoreboard-test-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 3, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 2 },
    farmSlots: 2,
    irSlots: 1,
  });
  await createTeam({ leagueId, managerUserId: "scoreboard-test-B", teamName: "Team B" });
  console.log("league:", leagueId, "teamA:", teamA);

  const startDate = isoDaysFromNow(-14);
  await generateSchedule({ leagueId, season, startDate, weekCount: 2, playoffTeams: 0, callerUserId: "scoreboard-test-A" });
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season }, orderBy: { periodNo: "asc" } });
  assert(periods.length === 2, "2 periods created");
  const period = periods[0];

  // Fixture players. pScorer actually scores within the period. pZeroHigh
  // and pZeroLow are both started but have no stat line *within* the
  // period (0.0 real points) — they differ only in career points (via a
  // stat line dated well outside the period), which is what the tie-break
  // is supposed to sort on. pBench is started BE (benched) with a huge
  // in-period stat line that must never show up in these results at all.
  const pScorer = await prisma.player.create({ data: { fullName: "Scoreboard Test Scorer (delete me)", primaryPosition: "C" } });
  const pZeroHigh = await prisma.player.create({ data: { fullName: "Scoreboard Test ZeroHigh (delete me)", primaryPosition: "C" } });
  const pZeroLow = await prisma.player.create({ data: { fullName: "Scoreboard Test ZeroLow (delete me)", primaryPosition: "C" } });
  const pBench = await prisma.player.create({ data: { fullName: "Scoreboard Test Bench (delete me)", primaryPosition: "C" } });

  await prisma.lineupEntry.createMany({
    data: [
      { teamId: teamA, playerId: pScorer.id, gameDate: period.startDate, lineupSlot: "C" },
      { teamId: teamA, playerId: pZeroHigh.id, gameDate: period.startDate, lineupSlot: "C" },
      { teamId: teamA, playerId: pZeroLow.id, gameDate: period.startDate, lineupSlot: "C" },
      { teamId: teamA, playerId: pBench.id, gameDate: period.startDate, lineupSlot: "BE" },
    ],
  });

  const farPast = new Date("2010-01-01T00:00:00.000Z");
  await prisma.gameStatLine.createMany({
    data: [
      // Real in-period points for the actual scorer.
      { playerId: pScorer.id, gameId: `sb-check-${pScorer.id}-inperiod`, gameDate: period.startDate, statsJson: { position: "C", goals: 5 } },
      // Career-only stat lines, dated outside the period, so the two 0.0
      // rows differ in career points without either scoring in-period.
      { playerId: pZeroHigh.id, gameId: `sb-check-${pZeroHigh.id}-career`, gameDate: farPast, statsJson: { position: "C", goals: 10 } },
      { playerId: pZeroLow.id, gameId: `sb-check-${pZeroLow.id}-career`, gameDate: farPast, statsJson: { position: "C", goals: 1 } },
      // Benched player's huge in-period line — must be excluded entirely.
      { playerId: pBench.id, gameId: `sb-check-${pBench.id}-inperiod`, gameDate: period.startDate, statsJson: { position: "C", goals: 100 } },
    ],
  });

  console.log("\n-- getTeamPeriodPlayerPoints --");
  const rows = await getTeamPeriodPlayerPoints(teamA, period.startDate, period.endDate, SCORING);
  assert(rows.length === 3, `exactly 3 started (non-BE) players returned, bench excluded — got ${rows.length}`);
  assert(rows[0].playerId === pScorer.id, "the real scorer sorts first");
  assert(rows[0].points === 10, `the real scorer has 10.0 points (5 goals * 2) — got ${rows[0].points}`);
  assert(rows[1].playerId === pZeroHigh.id, "of the two 0.0 rows, the higher-career-points player sorts second (right after the real scorer)");
  assert(rows[2].playerId === pZeroLow.id, "the lower-career-points 0.0 row sorts last");
  assert(rows[1].points === 0 && rows[2].points === 0, "both started-but-scoreless players show a real 0.0, not omitted");
  assert(
    !rows.some((r) => r.playerId === pBench.id),
    "the benched player never appears, regardless of his (much larger) in-period stat line",
  );

  console.log("\n-- getTeamTopScorersForPeriod --");
  const topScorers = await getTeamTopScorersForPeriod(teamA, period.startDate, period.endDate, SCORING, 3);
  assert(topScorers.length <= 3, `returns at most the requested limit — got ${topScorers.length}`);
  assert(topScorers[0].playerId === pScorer.id && topScorers[0].points === 10, "first entry is the real top scorer with matching points");

  console.log("\n-- sum(PeriodPlayerPoints.points) === getTeamScoreForPeriod --");
  const sumOfRows = rows.reduce((s, r) => s + r.points, 0);
  const teamScore = await getTeamScoreForPeriod(teamA, period, SCORING);
  assert(sumOfRows === teamScore, `sum of per-player points (${sumOfRows}) equals the team's period score (${teamScore})`);

  console.log("\n-- getMatchupDetail --");
  const matchup = await prisma.matchup.findFirst({ where: { matchupPeriodId: period.id } });
  assert(matchup !== null, "generateSchedule paired teamA vs teamB for period 1");
  const detail = await getMatchupDetail(matchup!.id, SCORING);
  assert(detail !== null, "getMatchupDetail returns a row for a real matchup id");
  const detailHome = detail!.home.teamId === teamA ? detail!.home : detail!.away;
  const detailAway = detail!.home.teamId === teamA ? detail!.away : detail!.home;
  assert(detailHome.score === teamScore, `detail's teamA score (${detailHome.score}) matches getTeamScoreForPeriod (${teamScore})`);
  const otherScore = await getTeamScoreForPeriod(detailAway.teamId, period, SCORING);
  assert(detailAway.score === otherScore, `detail's other-team score (${detailAway.score}) matches getTeamScoreForPeriod (${otherScore})`);
  assert(
    detailHome.players.reduce((s, p) => s + p.points, 0) === detailHome.score,
    "detail's per-player points for teamA sum to its own score",
  );
  const bogusDetail = await getMatchupDetail("nonexistent-matchup-id", SCORING);
  assert(bogusDetail === null, "a nonexistent matchup id returns null (the page turns this into notFound())");

  console.log("\nAll scoreboard checks passed.");

  console.log("\n-- cleanup --");
  const testPlayers = await prisma.player.findMany({ where: { fullName: { contains: "(delete me)" } } });
  const playerIds = testPlayers.map((p) => p.id);
  await prisma.gameStatLine.deleteMany({ where: { playerId: { in: playerIds } } });
  await deleteLeague(leagueId, "scoreboard-test-A");
  await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
  console.log("cleaned up");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
