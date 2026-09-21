// Regression check for Adjust Scoring (LM Tools batch Task 10,
// plans/lm-tools-batch.md). Seeding shape borrowed from
// scripts/scoreboard-seed.ts (lineups + stat lines in a completed period) and
// scripts/playoffs-check.ts (manually pushing a period's endDate into the
// past to mark it "just concluded").
//
// Covers: a +5.5 adjustment on the home team of a completed period flips the
// result in both getStandings and the scoreboard total; removing it restores
// both exactly; advancePlayoffsForLeague honors an adjustment when deciding a
// semifinal winner; a team with no matchup in the period is rejected; zero
// points is rejected; a non-commissioner caller is rejected; deleteLeague
// succeeds on a league that still has a live ScoreAdjustment row (exercising
// its new teardown-order entry).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";
import { addScoreAdjustment, removeScoreAdjustment, listScoreAdjustments } from "@/lib/matchups/adjustments";
import { getStandings, getScoreboardForPeriod, getMatchupDetail } from "@/lib/matchups/standings";
import { advancePlayoffsForLeague } from "@/lib/matchups/playoffs";

const SCORING = { goals: 2 };
const LEAGUE_NAME = "LM Tools Task 10 (delete me)";
const COMMISSIONER = "lm-adjscore-A";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function giveTeamGoals(teamId: string, playerId: string, date: Date, goals: number, tag: string) {
  await prisma.lineupEntry.create({ data: { teamId, playerId, gameDate: date, lineupSlot: "C" } });
  await prisma.gameStatLine.create({
    data: { playerId, gameId: `lm-adjscore-${tag}-${playerId}-${date.toISOString()}`, gameDate: date, statsJson: { position: "C", goals } },
  });
}

async function main() {
  const season = 2035;
  const { leagueId } = await createLeague({
    name: LEAGUE_NAME,
    season,
    managerUserId: COMMISSIONER,
    teamName: "Adj Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 2 },
    farmSlots: 1,
    irSlots: 1,
  });
  await createTeam({ leagueId, managerUserId: "lm-adjscore-B", teamName: "Adj Team B" });
  await createTeam({ leagueId, managerUserId: "lm-adjscore-C", teamName: "Adj Team C" });
  await createTeam({ leagueId, managerUserId: "lm-adjscore-D", teamName: "Adj Team D" });
  console.log("league:", leagueId);

  // Same shape as playoffs-check.ts: regular season already over, semifinal
  // period still open when first seeded.
  const startDate = isoDaysFromNow(-22);
  await generateSchedule({ leagueId, season, startDate, weekCount: 3, playoffTeams: 4, callerUserId: COMMISSIONER });
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season }, orderBy: { periodNo: "asc" } });
  assert(periods.length === 5, "3 regular-season + 2 playoff periods created");
  const [period0, , , semifinalPeriod, championshipPeriod] = periods;
  assert(!period0.isPlayoffs, "period 0 is regular season");
  assert(semifinalPeriod.isPlayoffs && championshipPeriod.isPlayoffs, "last 2 periods are playoffs");

  // ---- Phase 1: flip a completed regular-season result -------------------
  console.log("\n-- phase 1: adjustment flips a completed period's result --");
  const p0Matchup = await prisma.matchup.findFirstOrThrow({ where: { matchupPeriodId: period0.id } });
  const p0Home = p0Matchup.homeTeamId;
  const p0Away = p0Matchup.awayTeamId;

  const pHome = await prisma.player.create({ data: { fullName: "LM AdjScore Home (delete me)", primaryPosition: "C" } });
  const pAway = await prisma.player.create({ data: { fullName: "LM AdjScore Away (delete me)", primaryPosition: "C" } });
  await giveTeamGoals(p0Home, pHome.id, period0.startDate, 5, "p0home"); // 10 pts
  await giveTeamGoals(p0Away, pAway.id, period0.startDate, 7, "p0away"); // 14 pts

  const standingsBefore = await getStandings(leagueId, season, SCORING);
  const homeRowBefore = standingsBefore.find((r) => r.teamId === p0Home)!;
  const awayRowBefore = standingsBefore.find((r) => r.teamId === p0Away)!;
  assert(homeRowBefore.losses === 1 && awayRowBefore.wins === 1, "pre-adjustment: home team lost period 0 (10 < 14)");

  const sbBefore = await getScoreboardForPeriod(leagueId, season, SCORING, period0.periodNo);
  const sbMatchupBefore = sbBefore!.matchups.find((m) => m.matchupId === p0Matchup.id)!;
  assert(sbMatchupBefore.homeScore === 10 && sbMatchupBefore.awayScore === 14, "pre-adjustment scoreboard total is 10-14");

  // Rejections, before any real adjustment exists.
  let rejected = false;
  try {
    await addScoreAdjustment({ leagueId, matchupPeriodId: period0.id, teamId: p0Home, points: 0, callerUserId: COMMISSIONER });
  } catch {
    rejected = true;
  }
  assert(rejected, "zero points is rejected");

  rejected = false;
  try {
    await addScoreAdjustment({ leagueId, matchupPeriodId: period0.id, teamId: p0Home, points: 5.5, callerUserId: "lm-adjscore-B" });
  } catch {
    rejected = true;
  }
  assert(rejected, "a non-commissioner caller is rejected");

  const { teamId: teamNoMatchup } = await createTeam({ leagueId, managerUserId: "lm-adjscore-E", teamName: "Adj Team E (no matchup)" });
  rejected = false;
  try {
    await addScoreAdjustment({ leagueId, matchupPeriodId: period0.id, teamId: teamNoMatchup, points: 5.5, callerUserId: COMMISSIONER });
  } catch {
    rejected = true;
  }
  assert(rejected, "a team with no matchup in the period is rejected");
  const noMatchupCount = (await listScoreAdjustments(period0.id)).length;
  assert(noMatchupCount === 0, "none of the rejected attempts wrote a row");

  const adjustment = await addScoreAdjustment({
    leagueId,
    matchupPeriodId: period0.id,
    teamId: p0Home,
    points: 5.5,
    reason: "manual test correction",
    callerUserId: COMMISSIONER,
  });

  const standingsAfter = await getStandings(leagueId, season, SCORING);
  const homeRowAfter = standingsAfter.find((r) => r.teamId === p0Home)!;
  const awayRowAfter = standingsAfter.find((r) => r.teamId === p0Away)!;
  assert(homeRowAfter.wins === 1 && homeRowAfter.losses === 0, "+5.5 flips the home team to a win in getStandings (10 + 5.5 = 15.5 > 14)");
  assert(awayRowAfter.losses === 1 && awayRowAfter.wins === 0, "the away team's result flips to a loss correspondingly");

  const sbAfter = await getScoreboardForPeriod(leagueId, season, SCORING, period0.periodNo);
  const sbMatchupAfter = sbAfter!.matchups.find((m) => m.matchupId === p0Matchup.id)!;
  assert(sbMatchupAfter.homeScore === 15.5, "the scoreboard total reflects the adjustment (15.5)");
  assert(sbMatchupAfter.homeAdjustments.length === 1 && sbMatchupAfter.homeAdjustments[0].points === 5.5, "the matchup carries the adjustment for the modal");

  const detail = await getMatchupDetail(p0Matchup.id, SCORING);
  const detailHome = detail!.home.teamId === p0Home ? detail!.home : detail!.away;
  assert(detailHome.score === 15.5 && detailHome.adjustments.length === 1, "getMatchupDetail agrees with the scoreboard and exposes the adjustment");

  await removeScoreAdjustment({ id: adjustment.id, callerUserId: COMMISSIONER });
  const standingsRestored = await getStandings(leagueId, season, SCORING);
  const homeRowRestored = standingsRestored.find((r) => r.teamId === p0Home)!;
  assert(homeRowRestored.losses === 1 && homeRowRestored.wins === 0, "removing the adjustment restores the original loss in getStandings");
  const sbRestored = await getScoreboardForPeriod(leagueId, season, SCORING, period0.periodNo);
  const sbMatchupRestored = sbRestored!.matchups.find((m) => m.matchupId === p0Matchup.id)!;
  assert(sbMatchupRestored.homeScore === 10 && sbMatchupRestored.awayScore === 14, "removing the adjustment restores the original scoreboard total exactly");

  // ---- Phase 2: advancePlayoffsForLeague honors an adjustment ------------
  // bracketSize (4) equals the team count, so every team makes the bracket
  // regardless of exact standings order (the freshly-added, zero-activity
  // "no matchup" team from the rejection check above naturally ranks last —
  // 0 games played beats nothing). No need to engineer a specific seed
  // order: just read whichever two teams land in semifinal slot 0 and drive
  // the adjustment test off their real ids.
  console.log("\n-- phase 2: advancePlayoffsForLeague honors an adjustment when picking a semifinal winner --");
  await advancePlayoffsForLeague(leagueId, season);
  const semis = await prisma.matchup.findMany({ where: { matchupPeriodId: semifinalPeriod.id }, orderBy: { bracketSlot: "asc" } });
  assert(semis.length === 2, "semifinal round seeded from final standings once the regular season ended");
  const semi0 = semis[0];

  // Give the away side a clear lead, then adjust the home side past it —
  // advancePlayoffsForLeague must pick home, not away, once the period ends.
  const semiHomePlayer = await prisma.player.create({ data: { fullName: "LM AdjScore SemiHome (delete me)", primaryPosition: "C" } });
  const semiAwayPlayer = await prisma.player.create({ data: { fullName: "LM AdjScore SemiAway (delete me)", primaryPosition: "C" } });
  await giveTeamGoals(semi0.homeTeamId, semiHomePlayer.id, semifinalPeriod.startDate, 0, "semi-home"); // 0 pts
  await giveTeamGoals(semi0.awayTeamId, semiAwayPlayer.id, semifinalPeriod.startDate, 10, "semi-away"); // 20 pts
  const semiAdjustment = await addScoreAdjustment({
    leagueId,
    matchupPeriodId: semifinalPeriod.id,
    teamId: semi0.homeTeamId,
    points: 25,
    reason: "flip the semifinal for the regression check",
    callerUserId: COMMISSIONER,
  });
  await prisma.matchupPeriod.update({ where: { id: semifinalPeriod.id }, data: { endDate: new Date(Date.now() - 1000) } });

  await advancePlayoffsForLeague(leagueId, season);
  const championship = await prisma.matchup.findMany({ where: { matchupPeriodId: championshipPeriod.id } });
  assert(championship.length === 1, "championship seeded once the (adjusted) semifinal ended");
  const final = championship[0];
  assert(
    final.homeTeamId === semi0.homeTeamId || final.awayTeamId === semi0.homeTeamId,
    "the adjustment-boosted team (0 + 25 = 25 > 20) advances to the championship, not the team that led on raw stats alone",
  );
  assert(
    final.homeTeamId !== semi0.awayTeamId && final.awayTeamId !== semi0.awayTeamId,
    "the team that led before the adjustment (20 raw pts) did NOT advance",
  );

  console.log("\n-- cleanup (deleteLeague with a live ScoreAdjustment row still attached) --");
  const remaining = await listScoreAdjustments(semifinalPeriod.id);
  assert(remaining.length === 1 && remaining[0].id === semiAdjustment.id, "the semifinal adjustment is still live going into deleteLeague");
  const testPlayers = await prisma.player.findMany({ where: { fullName: { contains: "LM AdjScore" } } });
  const playerIds = testPlayers.map((p) => p.id);
  await prisma.gameStatLine.deleteMany({ where: { playerId: { in: playerIds } } });
  await deleteLeague(leagueId, COMMISSIONER);
  await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
  const leagueGone = await prisma.league.findUnique({ where: { id: leagueId } });
  assert(leagueGone === null, "deleteLeague succeeded despite the still-attached ScoreAdjustment row (new teardown-order entry worked)");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
