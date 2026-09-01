// Schedule generation — turns a league's teams into a season of weekly
// H2H matchups (DESIGN.md §2.4). Regular-season only for now; no playoff
// bracket (DESIGN.md §3 flags matchup-period count as still open, so the
// commissioner picks the week count at generation time rather than a
// hardcoded constant).

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

export interface GenerateScheduleInput {
  leagueId: string;
  season: number;
  startDate: string; // "YYYY-MM-DD" — period 1's first day
  weekCount: number;
  callerUserId: string;
}

export interface GenerateScheduleResult {
  periodsCreated: number;
  matchupsCreated: number;
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

  const rounds = generateRoundRobinRounds(teams.map((t) => t.id));
  const seasonStart = new Date(`${input.startDate}T00:00:00.000Z`);

  const periods = await prisma.matchupPeriod.createManyAndReturn({
    data: Array.from({ length: input.weekCount }, (_, i) => {
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
      };
    }),
  });

  // Flip home/away on repeated cycles (once every team's played every other
  // team once) so a season longer than one round robin doesn't keep handing
  // the same teams home advantage every time the cycle repeats.
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

  return { periodsCreated: periods.length, matchupsCreated: matchupRows.length };
}
