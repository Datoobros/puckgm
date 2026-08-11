// Shared column definitions — used by the players page's sortable table
// (PlayerStatsTable) and the team roster page's stats display, so both
// show identical stat labels rather than two definitions drifting apart.

import type { PlayerStatsRow } from "./rankings";

export interface StatColumn {
  key: string;
  label: string;
  get: (r: PlayerStatsRow) => number;
  format?: (v: number) => string;
}

// Column set swaps entirely between skater and goalie mode — matching
// ESPN's own team/free-agent tables, which never mix the two rather than
// padding one side with dashes.
export const SKATER_COLUMNS: StatColumn[] = [
  { key: "gp", label: "GP", get: (r) => r.gamesIngested },
  { key: "goals", label: "G", get: (r) => r.goals },
  { key: "assists", label: "A", get: (r) => r.assists },
  { key: "sog", label: "SOG", get: (r) => r.sog },
  { key: "hits", label: "HIT", get: (r) => r.hits },
  { key: "blockedShots", label: "BLK", get: (r) => r.blockedShots },
  { key: "pim", label: "PIM", get: (r) => r.pim },
  { key: "plusMinus", label: "+/-", get: (r) => r.plusMinus },
];

export const GOALIE_COLUMNS: StatColumn[] = [
  { key: "gp", label: "GP", get: (r) => r.gamesIngested },
  { key: "wins", label: "W", get: (r) => r.wins },
  { key: "saves", label: "SV", get: (r) => r.saves },
  { key: "shutouts", label: "SO", get: (r) => r.shutouts },
  { key: "goalsAgainst", label: "GA", get: (r) => r.goalsAgainst },
];

export const POINTS_COLUMNS: StatColumn[] = [
  { key: "points", label: "TOT", get: (r) => r.points, format: (v) => v.toFixed(1) },
  {
    key: "avg",
    label: "AVG",
    get: (r) => (r.gamesIngested > 0 ? r.points / r.gamesIngested : 0),
    format: (v) => v.toFixed(1),
  },
];
