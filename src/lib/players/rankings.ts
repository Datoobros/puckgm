// Shared between the players page and the home dashboard. One Postgres
// GROUP BY across all stat lines, returning one row per player, not every
// raw game row. See engine.ts's computeFantasyPointsFromTotals for why the
// scoring weights stay in one place rather than duplicated into this SQL.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeFantasyPointsFromTotals, STARTER_SCORING, type ScoringConfig } from "@/lib/scoring/engine";

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
  /** Defaults to STARTER_SCORING. Callers with a league in scope should
   * always pass that league's settingsJson.scoringConfig instead — this is
   * the one function every points display ultimately runs through. */
  scoringConfig?: ScoringConfig;
}): Promise<PlayerStatsRow[]> {
  if (opts?.playerIds && opts.playerIds.length === 0) return [];

  const whereClause = opts?.playerIds
    ? Prisma.sql`WHERE p.id IN (${Prisma.join(opts.playerIds)})`
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
    LEFT JOIN "GameStatLine" g ON g."playerId" = p.id
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
