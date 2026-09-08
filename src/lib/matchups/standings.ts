// Reads only — standings and scoreboard are always computed live from
// LineupEntry + GameStatLine, never from a stored score (see Matchup's
// schema comment). A team's score for a period is the sum of fantasy
// points from players who were actually STARTED (non-BE lineup slot) on
// days within that period, not the whole roster — this is the first place
// the Roster-vs-Lineup distinction (DESIGN.md §2.4) actually affects a
// number instead of just gating a select's options.

import { prisma } from "@/lib/db";
import { computeFantasyPoints, type ScoringConfig } from "@/lib/scoring/engine";

/** "Championship" / "Semifinal" / "Quarterfinal" for the last three rounds
 * of a bracket, else a plain "Round N" (unreachable in practice — brackets
 * are capped at 8 teams / 3 rounds in src/lib/matchups/playoffs.ts, kept
 * here for safety). roundIndex is 0-based from the start of the bracket.
 * Lives here rather than in playoffs.ts to avoid a circular import — that
 * file already imports getStandings/getTeamScoreForPeriod from here. */
export function playoffRoundLabel(totalRounds: number, roundIndex: number): string {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd === 1) return "Championship";
  if (fromEnd === 2) return "Semifinal";
  if (fromEnd === 3) return "Quarterfinal";
  return `Round ${roundIndex + 1}`;
}

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
  logoUrl: string | null;
  division: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Current streak, e.g. "W3"/"L1"/"T1", or "-" with no completed periods yet. */
  streak: string;
}

function computeStreak(results: ("W" | "L" | "T")[]): string {
  if (results.length === 0) return "-";
  const last = results[results.length - 1];
  let count = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === last; i--) count++;
  return `${last}${count}`;
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
    where: { leagueId, season, endDate: { lte: new Date() }, isPlayoffs: false },
    include: { matchups: true },
    orderBy: { periodNo: "asc" },
  });

  const rows = new Map<string, StandingsRow>(
    teams.map((t) => [
      t.id,
      {
        teamId: t.id,
        teamName: t.name,
        logoUrl: t.logoUrl,
        division: t.division,
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        streak: "-",
      },
    ]),
  );
  const resultsByTeam = new Map<string, ("W" | "L" | "T")[]>(teams.map((t) => [t.id, []]));

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

      const homeResult: "W" | "L" | "T" = homeScore > awayScore ? "W" : awayScore > homeScore ? "L" : "T";
      const awayResult: "W" | "L" | "T" = awayScore > homeScore ? "W" : homeScore > awayScore ? "L" : "T";
      if (homeResult === "W") {
        home.wins += 1;
        away.losses += 1;
      } else if (awayResult === "W") {
        away.wins += 1;
        home.losses += 1;
      } else {
        home.ties += 1;
        away.ties += 1;
      }
      resultsByTeam.get(m.homeTeamId)?.push(homeResult);
      resultsByTeam.get(m.awayTeamId)?.push(awayResult);
    }
  }

  for (const [teamId, results] of resultsByTeam) {
    const row = rows.get(teamId);
    if (row) row.streak = computeStreak(results);
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

export interface TeamSeasonStatsRow {
  teamId: string;
  goals: number;
  assists: number;
  sog: number;
  hits: number;
  blockedShots: number;
  pim: number;
  wins: number;
  goalsAgainst: number;
  saves: number;
  shutouts: number;
  otl: number;
}

function zeroSeasonStats(teamId: string): TeamSeasonStatsRow {
  return { teamId, goals: 0, assists: 0, sog: 0, hits: 0, blockedShots: 0, pim: 0, wins: 0, goalsAgainst: 0, saves: 0, shutouts: 0, otl: 0 };
}

/** Season-long raw stat totals per team — same "started players only" scope
 * as getTeamScoreForPeriod (non-BE LineupEntry rows), but summing raw
 * statsJson categories instead of fantasy points, over the whole season's
 * date range (every MatchupPeriod's span, regular + playoffs) rather than
 * one period at a time. All-zero for every team if no schedule exists yet. */
export async function getTeamSeasonStats(leagueId: string, season: number): Promise<Map<string, TeamSeasonStatsRow>> {
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const rows = new Map<string, TeamSeasonStatsRow>(teams.map((t) => [t.id, zeroSeasonStats(t.id)]));

  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season } });
  if (periods.length === 0) return rows;
  const start = new Date(Math.min(...periods.map((p) => p.startDate.getTime())));
  const end = new Date(Math.max(...periods.map((p) => p.endDate.getTime())));

  for (const team of teams) {
    const entries = await prisma.lineupEntry.findMany({
      where: { teamId: team.id, gameDate: { gte: start, lte: end }, lineupSlot: { not: "BE" } },
    });
    if (entries.length === 0) continue;

    const lines = await prisma.gameStatLine.findMany({
      where: { OR: entries.map((e) => ({ playerId: e.playerId, gameDate: e.gameDate })) },
    });

    const row = rows.get(team.id);
    if (!row) continue;
    for (const l of lines) {
      const s = l.statsJson as Record<string, unknown>;
      row.goals += Number(s.goals ?? 0);
      row.assists += Number(s.assists ?? 0);
      row.sog += Number(s.sog ?? 0);
      row.hits += Number(s.hits ?? 0);
      row.blockedShots += Number(s.blockedShots ?? 0);
      row.pim += Number(s.pim ?? 0);
      row.saves += Number(s.saves ?? 0);
      row.goalsAgainst += Number(s.goalsAgainst ?? 0);
      if (s.decision === "W") {
        row.wins += 1;
        if (Number(s.goalsAgainst ?? 0) === 0) row.shutouts += 1;
      } else if (s.decision === "O") {
        row.otl += 1;
      }
    }
  }

  return rows;
}

const MOVE_TYPES = new Set(["ROSTER_ADD", "ROSTER_DROP", "SEND_DOWN", "CALLUP", "IR_MOVE"]);

/** Count of real roster transactions per team this season — add/drop,
 * send-down/callup, IR moves, an awarded waiver claim, a FAAB win, and a
 * completed trade. Deliberately excludes LINEUP_EDIT (not a roster move),
 * COMMISSIONER_MOVE (not the manager's own action), a raw FAAB bid or any
 * not-yet-resolved trade state, and DRAFT_PICK/STARTUP (one-time draft
 * setup, not an in-season transaction). Scoped to the same season date
 * range getTeamSeasonStats uses. */
export async function getTeamMoveCounts(leagueId: string, season: number): Promise<Map<string, number>> {
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const counts = new Map<string, number>(teams.map((t) => [t.id, 0]));

  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season } });
  if (periods.length === 0) return counts;
  const start = new Date(Math.min(...periods.map((p) => p.startDate.getTime())));
  const end = new Date(Math.max(...periods.map((p) => p.endDate.getTime())));

  const logs = await prisma.transactionLog.findMany({
    where: { leagueId, effectiveAt: { gte: start, lte: end }, actorTeamId: { not: null } },
  });

  for (const log of logs) {
    if (!log.actorTeamId || !counts.has(log.actorTeamId)) continue;
    const payload = log.payload as Record<string, unknown> | null;
    const isMove =
      MOVE_TYPES.has(log.type) ||
      log.type === "FAAB_WIN" ||
      (log.type === "WAIVER_CLAIM" && payload?.event === "AWARDED") ||
      (log.type === "TRADE" && (payload?.event === "PROCESSED" || payload?.event === "FORCED"));
    if (isMove) counts.set(log.actorTeamId, (counts.get(log.actorTeamId) ?? 0) + 1);
  }

  return counts;
}

/** Every season this league has an actual schedule for, descending, always
 * including currentSeason even before any schedule is generated — so the
 * standings page's season selector always has at least one option. */
export async function getAvailableSeasons(leagueId: string, currentSeason: number): Promise<number[]> {
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId }, distinct: ["season"], select: { season: true } });
  const seasons = new Set(periods.map((p) => p.season));
  seasons.add(currentSeason);
  return [...seasons].sort((a, b) => b - a);
}

/** Rough, explicitly-not-a-simulation playoff-odds estimate: teams ranked
 * inside the bracket scale from 95 (1st) down to 55 (last bracket spot);
 * teams outside scale from 45 down to 5 (last place). null when there's no
 * bracket configured, or nothing yet to rank teams on. */
export function estimatePlayoffOdds(rank: number, totalTeams: number, bracketSize: number): number | null {
  if (bracketSize <= 0 || totalTeams <= 0) return null;
  if (rank <= bracketSize) {
    if (bracketSize === 1) return 95;
    const t = (rank - 1) / (bracketSize - 1);
    return Math.round(95 - t * 40);
  }
  const outCount = totalTeams - bracketSize;
  if (outCount <= 0) return 5;
  const t = (rank - bracketSize - 1) / Math.max(1, outCount - 1);
  return Math.round(45 - t * 40);
}

export interface ScoreboardMatchup {
  matchupId: string;
  homeTeamId: string;
  homeTeamName: string;
  homeScore: number;
  homeSeed: number | null;
  awayTeamId: string;
  awayTeamName: string;
  awayScore: number;
  awaySeed: number | null;
  final: boolean;
}

export interface ScoreboardPeriod {
  periodId: string;
  periodNo: number;
  startDate: Date;
  endDate: Date;
  isPlayoffs: boolean;
  roundLabel: string | null;
  matchups: ScoreboardMatchup[];
}

export interface TeamScheduleRow {
  matchupId: string | null; // null on a bye week
  periodNo: number;
  startDate: Date;
  endDate: Date;
  isPlayoffs: boolean;
  roundLabel: string | null;
  opponentTeamId: string | null;
  opponentTeamName: string | null;
  isHome: boolean;
  myScore: number;
  opponentScore: number;
  final: boolean;
  bye: boolean;
}

/** One team's full-season schedule, one row per period. A regular-season
 * period the team has no Matchup in (odd team count, see
 * generateRoundRobinRounds) becomes a `bye: true` row; a playoff period the
 * team never reached (eliminated, or bracket not seeded yet) is omitted
 * entirely rather than shown as a bye — those aren't the same thing. Scores
 * are only computed for periods whose week has actually finished, same rule
 * getStandings uses. */
export async function getTeamSchedule(
  teamId: string,
  leagueId: string,
  season: number,
  scoringConfig: ScoringConfig,
): Promise<TeamScheduleRow[]> {
  const [periods, teams] = await Promise.all([
    prisma.matchupPeriod.findMany({
      where: { leagueId, season },
      include: { matchups: { where: { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] } } },
      orderBy: { periodNo: "asc" },
    }),
    prisma.team.findMany({ where: { leagueId } }),
  ]);
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));
  const playoffPeriods = periods.filter((p) => p.isPlayoffs);

  const rows: TeamScheduleRow[] = [];
  for (const period of periods) {
    const m = period.matchups[0];
    const final = period.endDate <= new Date();
    if (!m) {
      if (!period.isPlayoffs) {
        rows.push({
          matchupId: null,
          periodNo: period.periodNo,
          startDate: period.startDate,
          endDate: period.endDate,
          isPlayoffs: false,
          roundLabel: null,
          opponentTeamId: null,
          opponentTeamName: null,
          isHome: false,
          myScore: 0,
          opponentScore: 0,
          final,
          bye: true,
        });
      }
      continue;
    }

    const isHome = m.homeTeamId === teamId;
    const opponentTeamId = isHome ? m.awayTeamId : m.homeTeamId;
    const [myScore, opponentScore] = final
      ? await Promise.all([
          getTeamScoreForPeriod(teamId, period.startDate, period.endDate, scoringConfig),
          getTeamScoreForPeriod(opponentTeamId, period.startDate, period.endDate, scoringConfig),
        ])
      : [0, 0];
    const roundIndex = playoffPeriods.findIndex((p) => p.id === period.id);

    rows.push({
      matchupId: m.id,
      periodNo: period.periodNo,
      startDate: period.startDate,
      endDate: period.endDate,
      isPlayoffs: period.isPlayoffs,
      roundLabel: roundIndex === -1 ? null : playoffRoundLabel(playoffPeriods.length, roundIndex),
      opponentTeamId,
      opponentTeamName: teamNameById.get(opponentTeamId) ?? "Unknown",
      isHome,
      myScore,
      opponentScore,
      final,
      bye: false,
    });
  }
  return rows;
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
        homeSeed: m.homeSeed,
        awayTeamId: m.awayTeamId,
        awayTeamName: m.awayTeam.name,
        awayScore,
        awaySeed: m.awaySeed,
        final,
      };
    }),
  );

  const playoffPeriods = periods.filter((p) => p.isPlayoffs);
  const roundIndex = playoffPeriods.findIndex((p) => p.id === target.id);

  return {
    periodId: target.id,
    periodNo: target.periodNo,
    startDate: target.startDate,
    endDate: target.endDate,
    isPlayoffs: target.isPlayoffs,
    roundLabel: roundIndex === -1 ? null : playoffRoundLabel(playoffPeriods.length, roundIndex),
    matchups: results,
  };
}
