// Schedule generation — turns a league's teams into a season of weekly
// H2H matchups (DESIGN.md §2.4). The commissioner picks the regular-season
// week count at generation time rather than a hardcoded constant. An
// optional playoff bracket (src/lib/matchups/playoffs.ts) can be appended
// in the same action — empty MatchupPeriods only, since there's nothing to
// pair until the regular season actually finishes.

import { prisma } from "@/lib/db";
import { getLeagueCommissioner } from "@/lib/leagues/mutations";

interface RoundPair {
  home: string;
  away: string;
}

/** Circle-method round robin. Odd team counts get a bye each round (the
 * team paired with the injected null "bye" slot simply has no matchup that
 * round). Returns one full cycle — every team plays every other team once;
 * generateSchedule() repeats this to fill however many weeks are requested. */
function generateRoundRobinRounds(teamIds: string[]): RoundPair[][] {
  const arr: (string | null)[] = [...teamIds];
  if (arr.length % 2 !== 0) arr.push(null);
  const n = arr.length;
  const fixed = arr[0];
  const rotating = arr.slice(1);
  const rounds: RoundPair[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const roundArr = [fixed, ...rotating];
    const pairs: RoundPair[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = roundArr[i];
      const b = roundArr[n - 1 - i];
      if (a !== null && b !== null) pairs.push({ home: a, away: b });
    }
    rounds.push(pairs);
    rotating.unshift(rotating.pop()!);
  }
  return rounds;
}

const VALID_PLAYOFF_SIZES = new Set([2, 4, 8]);

export interface GenerateScheduleInput {
  leagueId: string;
  season: number;
  startDate: string; // "YYYY-MM-DD" — period 1's first day
  weekCount: number;
  callerUserId: string;
  playoffTeams?: number; // 0/undefined = no playoff bracket
}

export interface GenerateScheduleResult {
  periodsCreated: number;
  matchupsCreated: number;
  playoffPeriodsCreated: number;
}

export async function generateSchedule(input: GenerateScheduleInput): Promise<GenerateScheduleResult> {
  const commissioner = await getLeagueCommissioner(input.leagueId);
  if (!commissioner || commissioner !== input.callerUserId) {
    throw new Error("Only the league commissioner can generate the schedule.");
  }

  const existing = await prisma.matchupPeriod.count({
    where: { leagueId: input.leagueId, season: input.season },
  });
  if (existing > 0) {
    throw new Error(`A schedule already exists for the ${input.season} season.`);
  }

  const teams = await prisma.team.findMany({ where: { leagueId: input.leagueId } });
  if (teams.length < 2) {
    throw new Error("Need at least two teams to generate a schedule.");
  }
  if (!Number.isInteger(input.weekCount) || input.weekCount < 1) {
    throw new Error("Season length must be at least one week.");
  }
  const playoffTeams = input.playoffTeams ?? 0;
  if (playoffTeams > 0) {
    if (!VALID_PLAYOFF_SIZES.has(playoffTeams)) {
      throw new Error("Playoff bracket must be 2, 4, or 8 teams.");
    }
    if (teams.length < playoffTeams) {
      throw new Error(`Need at least ${playoffTeams} teams for a ${playoffTeams}-team playoff bracket.`);
    }
  }

  const rounds = generateRoundRobinRounds(teams.map((t) => t.id));
  const seasonStart = new Date(`${input.startDate}T00:00:00.000Z`);
  const playoffRoundCount = playoffTeams > 0 ? Math.log2(playoffTeams) : 0;

  const periods = await prisma.matchupPeriod.createManyAndReturn({
    data: Array.from({ length: input.weekCount + playoffRoundCount }, (_, i) => {
      const periodStart = new Date(seasonStart);
      periodStart.setUTCDate(periodStart.getUTCDate() + i * 7);
      const periodEnd = new Date(periodStart);
      periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
      return {
        leagueId: input.leagueId,
        season: input.season,
        periodNo: i + 1,
        startDate: periodStart,
        endDate: periodEnd,
        isPlayoffs: i >= input.weekCount,
      };
    }),
  });

  // Flip home/away on repeated cycles (once every team's played every other
  // team once) so a season longer than one round robin doesn't keep handing
  // the same teams home advantage every time the cycle repeats. Only the
  // regular-season periods get matchups here — playoff periods are created
  // empty and filled in round by round by processDuePlayoffs() once there's
  // an actual regular-season result to seed from.
  const matchupRows: { matchupPeriodId: string; homeTeamId: string; awayTeamId: string }[] = [];
  for (let week = 0; week < input.weekCount; week++) {
    const round = rounds[week % rounds.length];
    const flip = Math.floor(week / rounds.length) % 2 === 1;
    for (const pair of round) {
      matchupRows.push({
        matchupPeriodId: periods[week].id,
        homeTeamId: flip ? pair.away : pair.home,
        awayTeamId: flip ? pair.home : pair.away,
      });
    }
  }

  await prisma.matchup.createMany({ data: matchupRows });

  return { periodsCreated: periods.length, matchupsCreated: matchupRows.length, playoffPeriodsCreated: playoffRoundCount };
}
