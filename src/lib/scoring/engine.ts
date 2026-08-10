// Config-driven fantasy scoring. Points are ALWAYS computed here, on read,
// from raw GameStatLine.statsJson — never persisted. See DESIGN.md §4.1: NHL
// corrects stats (e.g. reassigned assists) days after a game, and a baked-in
// point total would silently desync from reality when that happens.
//
// Point values are per-league config (DESIGN.md §2.4/§2.10) — this file
// defines the shape and the computation, not the values themselves.

import { prisma } from "@/lib/db";

export interface ScoringConfig {
  // skater
  goals?: number;
  assists?: number;
  sog?: number;
  hits?: number;
  blockedShots?: number;
  pim?: number;
  plusMinus?: number;
  giveaways?: number;
  takeaways?: number;
  // goalie — wins/shutouts derived from the boxscore's `decision` field
  // (confirmed values: "W" | "L" | "O"), not a TOI/score heuristic.
  wins?: number;
  shutouts?: number;
  saves?: number;
  goalsAgainst?: number;

  // NOT YET SUPPORTED: power-play points (PPP) and shorthanded points (SHP).
  // NHL's per-game boxscore endpoint exposes powerPlayGoals but not
  // power-play *assists*, so true PPP (PPG + PPA) can't be computed from
  // this data source alone. Needs a play-by-play or shift-chart feed.
  // Configuring these is a no-op today — left in the type so league configs
  // can carry the field without breaking, but computeFantasyPoints ignores it.
  powerPlayPoints?: number;
  shorthandedPoints?: number;
}

interface RawStatLine {
  position?: string;
  decision?: "W" | "L" | "O";
  goals?: number;
  assists?: number;
  sog?: number;
  hits?: number;
  blockedShots?: number;
  pim?: number;
  plusMinus?: number;
  giveaways?: number;
  takeaways?: number;
  goalsAgainst?: number;
  saves?: number;
}

function isGoalieLine(stats: RawStatLine): boolean {
  return stats.position === "G";
}

export function computeFantasyPoints(statsJson: unknown, config: ScoringConfig): number {
  const stats = statsJson as RawStatLine | null | undefined;
  if (!stats || typeof stats !== "object") return 0;

  if (isGoalieLine(stats)) {
    let total = 0;
    if (stats.decision === "W") {
      total += config.wins ?? 0;
      if ((stats.goalsAgainst ?? 1) === 0) total += config.shutouts ?? 0;
    }
    total += (stats.saves ?? 0) * (config.saves ?? 0);
    total += (stats.goalsAgainst ?? 0) * (config.goalsAgainst ?? 0);
    total += (stats.pim ?? 0) * (config.pim ?? 0);
    return total;
  }

  let total = 0;
  total += (stats.goals ?? 0) * (config.goals ?? 0);
  total += (stats.assists ?? 0) * (config.assists ?? 0);
  total += (stats.sog ?? 0) * (config.sog ?? 0);
  total += (stats.hits ?? 0) * (config.hits ?? 0);
  total += (stats.blockedShots ?? 0) * (config.blockedShots ?? 0);
  total += (stats.pim ?? 0) * (config.pim ?? 0);
  total += (stats.plusMinus ?? 0) * (config.plusMinus ?? 0);
  total += (stats.giveaways ?? 0) * (config.giveaways ?? 0);
  total += (stats.takeaways ?? 0) * (config.takeaways ?? 0);
  return total;
}

export async function computePlayerPoints(
  playerId: string,
  config: ScoringConfig,
  range?: { start: Date; end: Date },
): Promise<number> {
  const lines = await prisma.gameStatLine.findMany({
    where: {
      playerId,
      ...(range ? { gameDate: { gte: range.start, lte: range.end } } : {}),
    },
  });
  return lines.reduce((sum, l) => sum + computeFantasyPoints(l.statsJson, config), 0);
}

// Starting point only — values confirmed against ESPN's published defaults
// are marked; everything else is 0 until DESIGN.md's Stage 2 shadow
// validation (diff against a real mirrored ESPN league) fills them in.
// League-configurable per DESIGN.md §2.4; this is not a hardcoded ruleset.
export const STARTER_SCORING: ScoringConfig = {
  goals: 2, // confirmed ESPN default
  assists: 1, // confirmed ESPN default
  sog: 0.1, // confirmed ESPN default
  wins: 4, // confirmed ESPN default
  saves: 0.2, // confirmed ESPN default
  shutouts: 0,
  goalsAgainst: 0,
  hits: 0,
  blockedShots: 0,
  pim: 0,
  plusMinus: 0,
};
