// Reads only — standings and scoreboard are always computed live from
// LineupEntry + GameStatLine, never from a stored score (see Matchup's
// schema comment). A team's score for a period is the sum of fantasy
// points from players who were actually STARTED (non-BE lineup slot) on
// days within that period, not the whole roster — this is the first place
// the Roster-vs-Lineup distinction (DESIGN.md §2.4) actually affects a
// number instead of just gating a select's options.

import { prisma } from "@/lib/db";
import { computeFantasyPoints, type ScoringConfig } from "@/lib/scoring/engine";

export async function getTeamScoreForPeriod(
  teamId: string,
  start: Date,
  end: Date,
  scoringConfig: ScoringConfig,
): Promise<number> {
  const entries = await prisma.lineupEntry.findMany({
    where: { teamId, gameDate: { gte: start, lte: end }, lineupSlot: { not: "BE" } },
  });
  if (entries.length === 0) return 0;

  const lines = await prisma.gameStatLine.findMany({
    where: { OR: entries.map((e) => ({ playerId: e.playerId, gameDate: e.gameDate })) },
  });

  return lines.reduce((sum, l) => sum + computeFantasyPoints(l.statsJson, scoringConfig), 0);
}

export interface StandingsRow {
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

/** Only periods whose endDate has already passed count toward the record —
 * a period that hasn't finished is necessarily incomplete (games still to
 * play), so scoring it as a result yet would be premature, not just early. */
export async function getStandings(
  leagueId: string,
  season: number,
  scoringConfig: ScoringConfig,
): Promise<StandingsRow[]> {
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const periods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season, endDate: { lte: new Date() } },
    include: { matchups: true },
    orderBy: { periodNo: "asc" },
  });

  const rows = new Map<string, StandingsRow>(
    teams.map((t) => [
      t.id,
      { teamId: t.id, teamName: t.name, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
    ]),
  );

  for (const period of periods) {
    for (const m of period.matchups) {
      const [homeScore, awayScore] = await Promise.all([
        getTeamScoreForPeriod(m.homeTeamId, period.startDate, period.endDate, scoringConfig),
        getTeamScoreForPeriod(m.awayTeamId, period.startDate, period.endDate, scoringConfig),
      ]);
      const home = rows.get(m.homeTeamId);
      const away = rows.get(m.awayTeamId);
      if (!home || !away) continue;

      home.pointsFor += homeScore;
      home.pointsAgainst += awayScore;
      away.pointsFor += awayScore;
      away.pointsAgainst += homeScore;

      if (homeScore > awayScore) {
        home.wins += 1;
        away.losses += 1;
      } else if (awayScore > homeScore) {
        away.wins += 1;
        home.losses += 1;
      } else {
        home.ties += 1;
        away.ties += 1;
      }
    }
  }

  return [...rows.values()].sort((a, b) => {
    const gamesA = a.wins + a.losses + a.ties;
    const gamesB = b.wins + b.losses + b.ties;
    const pctA = gamesA > 0 ? (a.wins + a.ties * 0.5) / gamesA : 0;
    const pctB = gamesB > 0 ? (b.wins + b.ties * 0.5) / gamesB : 0;
    if (pctB !== pctA) return pctB - pctA;
    return b.pointsFor - a.pointsFor;
  });
}

export interface ScoreboardMatchup {
  matchupId: string;
  homeTeamId: string;
  homeTeamName: string;
  homeScore: number;
  awayTeamId: string;
  awayTeamName: string;
  awayScore: number;
  final: boolean;
}

export interface ScoreboardPeriod {
  periodId: string;
  periodNo: number;
  startDate: Date;
  endDate: Date;
  matchups: ScoreboardMatchup[];
}

/** periodNo omitted -> whichever period today's date falls in, or the
 * nearest upcoming one if the season hasn't started yet, or the most
 * recent one if the season's schedule has run out. */
export async function getScoreboardForPeriod(
  leagueId: string,
  season: number,
  scoringConfig: ScoringConfig,
  periodNo?: number,
): Promise<ScoreboardPeriod | null> {
  const periods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season },
    orderBy: { periodNo: "asc" },
  });
  if (periods.length === 0) return null;

  let target = periodNo !== undefined ? periods.find((p) => p.periodNo === periodNo) : undefined;
  if (!target) {
    const now = new Date();
    target =
      periods.find((p) => p.startDate <= now && now <= p.endDate) ??
      periods.find((p) => p.startDate > now) ??
      periods[periods.length - 1];
  }

  const matchups = await prisma.matchup.findMany({
    where: { matchupPeriodId: target.id },
    include: { homeTeam: true, awayTeam: true },
  });

  const final = target.endDate <= new Date();
  const results = await Promise.all(
    matchups.map(async (m) => {
      const [homeScore, awayScore] = await Promise.all([
        getTeamScoreForPeriod(m.homeTeamId, target.startDate, target.endDate, scoringConfig),
        getTeamScoreForPeriod(m.awayTeamId, target.startDate, target.endDate, scoringConfig),
      ]);
      return {
        matchupId: m.id,
        homeTeamId: m.homeTeamId,
        homeTeamName: m.homeTeam.name,
        homeScore,
        awayTeamId: m.awayTeamId,
        awayTeamName: m.awayTeam.name,
        awayScore,
        final,
      };
    }),
  );

  return {
    periodId: target.id,
    periodNo: target.periodNo,
    startDate: target.startDate,
    endDate: target.endDate,
    matchups: results,
  };
}
