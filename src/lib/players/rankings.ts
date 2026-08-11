// Shared between the players page and the home dashboard — both need "top
// players by fantasy points." One Postgres GROUP BY across all stat lines,
// returning one row per player, not every raw game row. See engine.ts's
// computeFantasyPointsFromTotals for why the scoring weights stay in one
// place rather than duplicated into this SQL.

import { prisma } from "@/lib/db";
import { computeFantasyPointsFromTotals, STARTER_SCORING } from "@/lib/scoring/engine";

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

export async function topPlayersByPoints(limit: number) {
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
    GROUP BY p.id
  `;

  const withPoints = rows.map((r) => ({
    ...r,
    points: computeFantasyPointsFromTotals(r, STARTER_SCORING),
  }));
  withPoints.sort((a, b) => b.points - a.points);
  return withPoints.slice(0, limit);
}
