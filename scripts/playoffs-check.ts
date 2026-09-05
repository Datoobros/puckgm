import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";
import { standardSeedOrder, advancePlayoffsForLeague } from "@/lib/matchups/playoffs";
import { getStandings } from "@/lib/matchups/standings";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function giveTeamScore(teamId: string, playerId: string, date: Date, goals: number) {
  await prisma.lineupEntry.create({ data: { teamId, playerId, gameDate: date, lineupSlot: "C" } });
  await prisma.gameStatLine.create({
    data: {
      playerId,
      gameId: `playoff-check-${playerId}-${date.toISOString()}`,
      gameDate: date,
      statsJson: { position: "C", goals },
    },
  });
}

async function main() {
  console.log("-- standardSeedOrder --");
  assert(JSON.stringify(standardSeedOrder(2)) === JSON.stringify([1, 2]), "seed order for 2 is [1,2]");
  assert(JSON.stringify(standardSeedOrder(4)) === JSON.stringify([1, 4, 2, 3]), "seed order for 4 is [1,4,2,3]");
  assert(JSON.stringify(standardSeedOrder(8)) === JSON.stringify([1, 8, 4, 5, 2, 7, 3, 6]), "seed order for 8 is [1,8,4,5,2,7,3,6]");

  const season = 2027;
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Playoffs Test League (delete me)",
    season,
    managerUserId: "playoff-test-A",
    teamName: "Team A",
    rosterComposition: { C: 1, LW: 1, RW: 1, D: 1, G: 1, UTIL: 1, BENCH: 2 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "playoff-test-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "playoff-test-C", teamName: "Team C" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "playoff-test-D", teamName: "Team D" });
  console.log("league:", leagueId, { teamA, teamB, teamC, teamD });

  // Regular season ends 2 days ago; the semifinal period (right after) spans
  // -1 day to +5 days from now, i.e. not over yet — lets us test that round
  // 1 doesn't get created before the regular season actually ends, and that
  // round 2 doesn't get created before round 1 actually ends.
  const startDate = isoDaysFromNow(-22);
  await generateSchedule({ leagueId, season, startDate, weekCount: 3, playoffTeams: 4, callerUserId: "playoff-test-A" });

  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season }, orderBy: { periodNo: "asc" } });
  assert(periods.length === 5, "3 regular-season + 2 playoff periods created (log2(4) = 2 rounds)");
  assert(periods.slice(0, 3).every((p) => !p.isPlayoffs), "first 3 periods are regular season");
  assert(periods.slice(3).every((p) => p.isPlayoffs), "last 2 periods are playoffs");
  const semifinalPeriod = periods[3];
  const championshipPeriod = periods[4];

  // Fixed, opponent-independent scores across all 3 regular-season periods —
  // team strength alone determines the record: A 3-0, B 2-1, C 1-2, D 0-3.
  const players = {
    A: await prisma.player.create({ data: { fullName: "Playoff Test A (delete me)", primaryPosition: "C" } }),
    B: await prisma.player.create({ data: { fullName: "Playoff Test B (delete me)", primaryPosition: "C" } }),
    C: await prisma.player.create({ data: { fullName: "Playoff Test C (delete me)", primaryPosition: "C" } }),
    D: await prisma.player.create({ data: { fullName: "Playoff Test D (delete me)", primaryPosition: "C" } }),
  };
  const strength: Record<string, number> = { A: 50, B: 40, C: 30, D: 20 }; // goals -> 2x under STARTER_SCORING
  const teamIdByLabel: Record<string, string> = { A: teamA, B: teamB, C: teamC, D: teamD };
  for (const period of periods.slice(0, 3)) {
    for (const label of ["A", "B", "C", "D"] as const) {
      await giveTeamScore(teamIdByLabel[label], players[label].id, period.startDate, strength[label]);
    }
  }

  const standings = await getStandings(leagueId, season, { goals: 2 });
  assert(standings.map((r) => r.teamId).join(",") === [teamA, teamB, teamC, teamD].join(","), "standings order is A,B,C,D as designed (fixed opponent-independent scores)");

  console.log("\n-- round 1 seeds from standings, but only once the regular season has ended --");
  await advancePlayoffsForLeague(leagueId, season);
  const semisAfterFirstCall = await prisma.matchup.findMany({ where: { matchupPeriodId: semifinalPeriod.id }, orderBy: { bracketSlot: "asc" } });
  assert(semisAfterFirstCall.length === 2, "semifinal round seeded (regular season had already ended)");
  const champBeforeReady = await prisma.matchup.findMany({ where: { matchupPeriodId: championshipPeriod.id } });
  assert(champBeforeReady.length === 0, "championship not created yet — the semifinal period hasn't ended");

  const semi0 = semisAfterFirstCall.find((m) => m.bracketSlot === 0)!;
  const semi1 = semisAfterFirstCall.find((m) => m.bracketSlot === 1)!;
  assert(semi0.homeTeamId === teamA && semi0.homeSeed === 1 && semi0.awayTeamId === teamD && semi0.awaySeed === 4, "slot 0 is seed 1 (A) vs seed 4 (D), matching standardSeedOrder(4)'s (1,4) pair");
  assert(semi1.homeTeamId === teamB && semi1.homeSeed === 2 && semi1.awayTeamId === teamC && semi1.awaySeed === 3, "slot 1 is seed 2 (B) vs seed 3 (C), matching the (2,3) pair");

  console.log("\n-- play the semifinal: A beats D clearly, B ties C (tie must go to the better seed, B) --");
  await giveTeamScore(teamA, players.A.id, semifinalPeriod.startDate, 50); // 100 pts
  await giveTeamScore(teamD, players.D.id, semifinalPeriod.startDate, 5); // 10 pts
  await giveTeamScore(teamB, players.B.id, semifinalPeriod.startDate, 20); // 40 pts
  await giveTeamScore(teamC, players.C.id, semifinalPeriod.startDate, 20); // 40 pts — tie
  await prisma.matchupPeriod.update({ where: { id: semifinalPeriod.id }, data: { endDate: new Date(Date.now() - 1000) } });

  await advancePlayoffsForLeague(leagueId, season);
  const champAfter = await prisma.matchup.findMany({ where: { matchupPeriodId: championshipPeriod.id } });
  assert(champAfter.length === 1, "championship created once the semifinal period ended");
  const final = champAfter[0];
  assert(
    (final.homeTeamId === teamA && final.homeSeed === 1) || (final.awayTeamId === teamA && final.awaySeed === 1),
    "Team A (clear semifinal winner) is in the final with seed 1",
  );
  assert(
    (final.homeTeamId === teamB && final.homeSeed === 2) || (final.awayTeamId === teamB && final.awaySeed === 2),
    "Team B (tie-break winner as the better seed) is in the final with seed 2, not Team C",
  );
  assert(final.homeTeamId === teamA && final.homeSeed === 1, "the better seed (A) is home in the final");

  console.log("\n-- getStandings never counts playoff results --");
  const standingsAfter = await getStandings(leagueId, season, { goals: 2 });
  const teamARow = standingsAfter.find((r) => r.teamId === teamA)!;
  assert(teamARow.wins + teamARow.losses + teamARow.ties === 3, "Team A's record is still 3 games (regular season only), despite also having played a semifinal");

  console.log("\n-- cleanup (via the real deleteLeague, exercising its new LineupEntry fix) --");
  const testPlayers = await prisma.player.findMany({ where: { fullName: { contains: "Playoff Test" } } });
  const playerIds = testPlayers.map((p) => p.id);
  await prisma.gameStatLine.deleteMany({ where: { playerId: { in: playerIds } } }); // not team-scoped — deleteLeague can't reach these
  await deleteLeague(leagueId, "playoff-test-A");
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
