// Shared between the players page and the home dashboard. One Postgres
// GROUP BY across all stat lines, returning one row per player, not every
// raw game row. See engine.ts's computeFantasyPointsFromTotals for why the
// scoring weights stay in one place rather than duplicated into this SQL.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  computeFantasyPoints,
  computeFantasyPointsFromTotals,
  STARTER_SCORING,
  type ScoringConfig,
} from "@/lib/scoring/engine";

export interface PlayerAggregateRow {
  id: string;
  fullName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
  careerNhlGp: number;
  gamesIngested: number;
  goals: number;
  assists: number;
  sog: number;
  hits: number;
  blockedShots: number;
  pim: number;
  plusMinus: number;
  saves: number;
  goalsAgainst: number;
  wins: number;
  shutouts: number;
}

export interface PlayerStatsRow extends PlayerAggregateRow {
  points: number;
}

/**
 * playerIds omitted -> every player in the pool (~1091 rows, ~1.5s, all in
 * one query — see git history for the timing check before this shipped).
 * playerIds provided -> just those (used for name search results, which
 * must stay exhaustive across all players regardless of any display cap
 * applied elsewhere).
 */
export async function getPlayerStatsAggregate(opts?: {
  playerIds?: string[];
  limit?: number;
  /** Restricts summed games to this range without dropping zero-game
   * players from the result — see the JOIN condition below. Used for
   * season-scoped views (e.g. "2025-26" vs "2026-27"); omit for career. */
  dateRange?: { start: Date; end: Date };
  /** Defaults to STARTER_SCORING. Callers with a league in scope should
   * always pass that league's settingsJson.scoringConfig instead — this is
   * the one function every points display ultimately runs through. */
  scoringConfig?: ScoringConfig;
}): Promise<PlayerStatsRow[]> {
  if (opts?.playerIds && opts.playerIds.length === 0) return [];

  const whereClause = opts?.playerIds
    ? Prisma.sql`WHERE p.id IN (${Prisma.join(opts.playerIds)})`
    : Prisma.empty;

  // The date filter belongs on the JOIN, not a WHERE clause — a WHERE here
  // would turn this into an inner join and drop every player with zero
  // games in range instead of showing them with all-zero totals.
  const dateFilter = opts?.dateRange
    ? Prisma.sql`AND g."gameDate" >= ${opts.dateRange.start} AND g."gameDate" <= ${opts.dateRange.end}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<PlayerAggregateRow[]>`
    SELECT
      p.id,
      p."fullName",
      p."primaryPosition",
      p."currentNhlOrg",
      p."careerNhlGp",
      COUNT(g.id)::int AS "gamesIngested",
      COALESCE(SUM((g."statsJson"->>'goals')::numeric), 0)::float AS goals,
      COALESCE(SUM((g."statsJson"->>'assists')::numeric), 0)::float AS assists,
      COALESCE(SUM((g."statsJson"->>'sog')::numeric), 0)::float AS sog,
      COALESCE(SUM((g."statsJson"->>'hits')::numeric), 0)::float AS hits,
      COALESCE(SUM((g."statsJson"->>'blockedShots')::numeric), 0)::float AS "blockedShots",
      COALESCE(SUM((g."statsJson"->>'pim')::numeric), 0)::float AS pim,
      COALESCE(SUM((g."statsJson"->>'plusMinus')::numeric), 0)::float AS "plusMinus",
      COALESCE(SUM((g."statsJson"->>'saves')::numeric), 0)::float AS saves,
      COALESCE(SUM((g."statsJson"->>'goalsAgainst')::numeric), 0)::float AS "goalsAgainst",
      COALESCE(SUM(CASE WHEN g."statsJson"->>'decision' = 'W' THEN 1 ELSE 0 END), 0)::int AS wins,
      COALESCE(SUM(CASE WHEN g."statsJson"->>'decision' = 'W' AND (g."statsJson"->>'goalsAgainst')::numeric = 0 THEN 1 ELSE 0 END), 0)::int AS shutouts
    FROM "Player" p
    LEFT JOIN "GameStatLine" g ON g."playerId" = p.id ${dateFilter}
    ${whereClause}
    GROUP BY p.id
  `;

  const config = opts?.scoringConfig ?? STARTER_SCORING;
  const withPoints = rows.map((r) => ({
    ...r,
    points: computeFantasyPointsFromTotals(r, config),
  }));
  withPoints.sort((a, b) => b.points - a.points);
  return opts?.limit ? withPoints.slice(0, opts.limit) : withPoints;
}

export interface PlayerSearchResult {
  id: string;
  fullName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
}

/** A fast, plain name lookup for the typeahead dropdown — no stat
 * aggregation, unlike getPlayerStatsAggregate above. "contains" on fullName
 * already matches both first and last name (e.g. "conn" matches "Kyle
 * Connor" via the last name and "Connor McDavid" via the first). */
export async function searchPlayersByName(query: string, limit = 8): Promise<PlayerSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return prisma.player.findMany({
    where: { fullName: { contains: trimmed, mode: "insensitive" } },
    select: { id: true, fullName: true, primaryPosition: true, currentNhlOrg: true },
    take: limit,
    orderBy: { careerNhlGp: "desc" },
  });
}

/** One row per player for a single calendar date — that day's raw box
 * score run through the scoring config, not a season sum. Players with no
 * completed game that date are simply absent from the map (same "missing
 * = —" convention the season aggregate's callers already use). */
export async function getPlayerDailyStats(
  playerIds: string[],
  date: string,
  scoringConfig: ScoringConfig,
): Promise<Map<string, PlayerStatsRow>> {
  if (playerIds.length === 0) return new Map();

  const gameDate = new Date(`${date}T00:00:00.000Z`);
  const lines = await prisma.gameStatLine.findMany({
    where: { playerId: { in: playerIds }, gameDate },
    include: { player: true },
  });

  const map = new Map<string, PlayerStatsRow>();
  for (const line of lines) {
    const s = line.statsJson as Record<string, unknown>;
    const num = (k: string) => Number(s[k] ?? 0);
    const won = s.decision === "W";
    map.set(line.playerId, {
      id: line.playerId,
      fullName: line.player.fullName,
      primaryPosition: line.player.primaryPosition,
      currentNhlOrg: line.player.currentNhlOrg,
      careerNhlGp: line.player.careerNhlGp,
      gamesIngested: 1,
      goals: num("goals"),
      assists: num("assists"),
      sog: num("sog"),
      hits: num("hits"),
      blockedShots: num("blockedShots"),
      pim: num("pim"),
      plusMinus: num("plusMinus"),
      saves: num("saves"),
      goalsAgainst: num("goalsAgainst"),
      wins: won ? 1 : 0,
      shutouts: won && num("goalsAgainst") === 0 ? 1 : 0,
      points: computeFantasyPoints(line.statsJson, scoringConfig),
    });
  }
  return map;
}
