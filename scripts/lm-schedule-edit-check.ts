// Regression check for the League Schedule page + Edit Head-to-Head Schedule
// (LM Tools batch Task 11, plans/lm-tools-batch.md). Seeding shape borrowed
// from scripts/lm-adjust-scoring-check.ts (createLeague/createTeam +
// generateSchedule, exact-name cleanup on the shared prod database).
//
// Covers: swapping week 2's pairings replaces the Matchup rows while every
// team keeps real history; a duplicate team in a submission is rejected and
// changes nothing; editing a backdated (already-started) week is rejected;
// editing a playoff period is rejected; getStandings is unaffected by an
// edit to a week that hasn't been played; a second, 3-team league proves a
// team left out of the submitted pairs simply gets a bye.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, teamHasHistory } from "@/lib/leagues/mutations";
import { generateSchedule, updatePeriodMatchups } from "@/lib/matchups/mutations";
import { getStandings, getLeagueSchedule } from "@/lib/matchups/standings";

const SCORING = { goals: 2 };
const LEAGUE_NAME = "LM Tools Task 11 (delete me)";
const BYE_LEAGUE_NAME = "LM Tools Task 11 Bye (delete me)";
const COMMISSIONER = "lm-sched-A";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

/** Always at least one full day out, and a full week out if today already
 * is Monday — keeps every initially-generated period safely in the future
 * so only the explicit backdate step below makes anything "started". */
function nextMondayISO(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = ((1 - day + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function expectRejected(fn: () => Promise<unknown>, msgContains: string, label: string) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes(msgContains), `${label} (message: "${msg}")`);
    return;
  }
  throw new Error(`ASSERTION FAILED: ${label} — call unexpectedly succeeded`);
}

async function main() {
  const season = 2036;

  // ---- Main league: 4 teams, playoff bracket for the "playoff period
  // rejected" check ------------------------------------------------------
  const { leagueId } = await createLeague({
    name: LEAGUE_NAME,
    season,
    managerUserId: COMMISSIONER,
    teamName: "Sched Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 2 },
    farmSlots: 1,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lm-sched-B", teamName: "Sched Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "lm-sched-C", teamName: "Sched Team C" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "lm-sched-D", teamName: "Sched Team D" });
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const teamA = teams.find((t) => t.name === "Sched Team A")!.id;
  console.log("league:", leagueId);

  const startDate = nextMondayISO();
  await generateSchedule({ leagueId, season, startDate, weekCount: 4, playoffTeams: 2, callerUserId: COMMISSIONER });
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season }, orderBy: { periodNo: "asc" } });
  assert(periods.length === 5, "4 regular-season + 1 playoff period created");
  const [week1, week2, , , championshipPeriod] = periods;
  assert(!week1.isPlayoffs && !week2.isPlayoffs, "weeks 1-2 are regular season");
  assert(championshipPeriod.isPlayoffs, "period 5 is the championship");
  assert(week1.startDate > new Date(), "week 1 hasn't started yet (generated for next Monday)");

  // ---- Phase 1: swap week 2's pairings -----------------------------------
  console.log("\n-- phase 1: swap week 2's pairings --");
  const week2Before = await prisma.matchup.findMany({ where: { matchupPeriodId: week2.id } });
  assert(week2Before.length === 2, "week 2 starts with 2 matchups (4 teams, round robin)");
  const week2MatchupIds = week2Before.map((m) => m.id);

  // Reverse home/away on one pair and cross-pair the two matchups so the new
  // pairing is genuinely different from the round-robin's original draw.
  const newPairs = [
    { homeTeamId: teamA, awayTeamId: teamC },
    { homeTeamId: teamB, awayTeamId: teamD },
  ];
  await updatePeriodMatchups({ leagueId, periodId: week2.id, pairs: newPairs, callerUserId: COMMISSIONER });

  const week2After = await prisma.matchup.findMany({ where: { matchupPeriodId: week2.id } });
  assert(week2After.length === 2, "week 2 still has exactly 2 matchups after the edit");
  assert(
    week2After.every((m) => !week2MatchupIds.includes(m.id)),
    "the original Matchup rows were replaced, not updated in place",
  );
  const hasAvC = week2After.some((m) => (m.homeTeamId === teamA && m.awayTeamId === teamC) || (m.homeTeamId === teamC && m.awayTeamId === teamA));
  const hasBvD = week2After.some((m) => (m.homeTeamId === teamB && m.awayTeamId === teamD) || (m.homeTeamId === teamD && m.awayTeamId === teamB));
  assert(hasAvC && hasBvD, "week 2 now pairs A-vs-C and B-vs-D as submitted");

  for (const [label, id] of [["A", teamA], ["B", teamB], ["C", teamC], ["D", teamD]] as const) {
    assert(await teamHasHistory(id), `team ${label} still has real history after the swap (other weeks' Matchup rows)`);
  }

  // ---- Phase 2: duplicate team rejected -----------------------------------
  console.log("\n-- phase 2: duplicate team rejected --");
  await expectRejected(
    () =>
      updatePeriodMatchups({
        leagueId,
        periodId: week2.id,
        pairs: [
          { homeTeamId: teamA, awayTeamId: teamB },
          { homeTeamId: teamA, awayTeamId: teamC },
        ],
        callerUserId: COMMISSIONER,
      }),
    "more than one matchup",
    "a submission with the same team in two matchups is rejected",
  );
  const week2Unchanged = await prisma.matchup.findMany({ where: { matchupPeriodId: week2.id } });
  assert(
    week2Unchanged.length === 2 && week2Unchanged.every((m) => week2After.some((m2) => m2.id === m.id)),
    "the rejected duplicate submission left week 2 untouched",
  );

  // ---- Phase 3: editing an already-started week is rejected --------------
  console.log("\n-- phase 3: backdated week 1 can't be edited --");
  const week1MatchupsBefore = await prisma.matchup.findMany({ where: { matchupPeriodId: week1.id } });
  await prisma.matchupPeriod.update({ where: { id: week1.id }, data: { startDate: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  await expectRejected(
    () =>
      updatePeriodMatchups({
        leagueId,
        periodId: week1.id,
        pairs: [{ homeTeamId: teamA, awayTeamId: teamB }],
        callerUserId: COMMISSIONER,
      }),
    "started",
    "editing week 1 once its startDate is in the past is rejected",
  );
  const week1MatchupsAfter = await prisma.matchup.findMany({ where: { matchupPeriodId: week1.id } });
  assert(
    week1MatchupsAfter.length === week1MatchupsBefore.length &&
      week1MatchupsAfter.every((m) => week1MatchupsBefore.some((m2) => m2.id === m.id)),
    "week 1's matchups are unchanged by the rejected edit",
  );

  // ---- Phase 4: editing a playoff period is rejected ----------------------
  console.log("\n-- phase 4: playoff period can't be edited --");
  await expectRejected(
    () =>
      updatePeriodMatchups({
        leagueId,
        periodId: championshipPeriod.id,
        pairs: [{ homeTeamId: teamA, awayTeamId: teamB }],
        callerUserId: COMMISSIONER,
      }),
    "standings",
    "editing the championship (playoff) period is rejected",
  );

  // ---- Phase 5: getStandings unaffected by a future-week edit -------------
  console.log("\n-- phase 5: getStandings is unaffected by an edit to an unplayed week --");
  const standings = await getStandings(leagueId, season, SCORING);
  assert(
    standings.every((r) => r.wins === 0 && r.losses === 0 && r.ties === 0),
    "no team has a recorded result — every affected period is still in the future, so editing it can't have moved a completed record",
  );

  const schedule = await getLeagueSchedule(leagueId, season, SCORING);
  const week2Schedule = schedule.find((p) => p.periodId === week2.id)!;
  assert(week2Schedule.editable, "week 2 (still in the future) is reported editable by getLeagueSchedule");
  const week1Schedule = schedule.find((p) => p.periodId === week1.id)!;
  assert(!week1Schedule.editable, "week 1 (backdated to the past) is reported not editable by getLeagueSchedule");
  const champSchedule = schedule.find((p) => p.periodId === championshipPeriod.id)!;
  assert(!champSchedule.editable, "the championship period is reported not editable by getLeagueSchedule");

  console.log("\n-- cleanup (main league) --");
  await deleteLeague(leagueId, COMMISSIONER);
  const leagueGone = await prisma.league.findUnique({ where: { id: leagueId } });
  assert(leagueGone === null, "main league deleted");

  // ---- Phase 6: a 3-team league edit with one team left out is a bye -----
  console.log("\n-- phase 6: 3-team league — a team left out of the submitted pairs gets a bye --");
  const byeCommissioner = "lm-sched-bye-A";
  const { leagueId: byeLeagueId } = await createLeague({
    name: BYE_LEAGUE_NAME,
    season,
    managerUserId: byeCommissioner,
    teamName: "Bye Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 0, RW: 0, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 2 },
    farmSlots: 1,
    irSlots: 1,
  });
  const { teamId: byeTeamB } = await createTeam({ leagueId: byeLeagueId, managerUserId: "lm-sched-bye-B", teamName: "Bye Team B" });
  const { teamId: byeTeamC } = await createTeam({ leagueId: byeLeagueId, managerUserId: "lm-sched-bye-C", teamName: "Bye Team C" });
  const byeTeams = await prisma.team.findMany({ where: { leagueId: byeLeagueId } });
  const byeTeamA = byeTeams.find((t) => t.name === "Bye Team A")!.id;
  console.log("bye league:", byeLeagueId);

  await generateSchedule({
    leagueId: byeLeagueId,
    season,
    startDate: nextMondayISO(),
    weekCount: 1,
    callerUserId: byeCommissioner,
  });
  const [byePeriod] = await prisma.matchupPeriod.findMany({ where: { leagueId: byeLeagueId, season }, orderBy: { periodNo: "asc" } });

  // Leave byeTeamC out entirely — only A-vs-B submitted.
  await updatePeriodMatchups({
    leagueId: byeLeagueId,
    periodId: byePeriod.id,
    pairs: [{ homeTeamId: byeTeamA, awayTeamId: byeTeamB }],
    callerUserId: byeCommissioner,
  });

  const byeSchedule = await getLeagueSchedule(byeLeagueId, season, SCORING);
  const byeSchedulePeriod = byeSchedule.find((p) => p.periodId === byePeriod.id)!;
  assert(byeSchedulePeriod.matchups.length === 1, "only the submitted A-vs-B matchup exists for the week");
  const byeMatchup = byeSchedulePeriod.matchups[0];
  assert(
    byeMatchup.home.teamId !== byeTeamC && byeMatchup.away.teamId !== byeTeamC,
    "team C, left out of the submitted pairs, appears in no matchup that week — a bye",
  );

  console.log("\n-- cleanup (bye league) --");
  await deleteLeague(byeLeagueId, byeCommissioner);
  const byeLeagueGone = await prisma.league.findUnique({ where: { id: byeLeagueId } });
  assert(byeLeagueGone === null, "bye league deleted");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
