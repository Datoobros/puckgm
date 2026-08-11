// Per-team game lookup for a single date — tells the lineup UI who a
// rostered player faces that day and whether his game has already begun.
// Regular season only, same scope as the rest of the app right now.

import { getDaySchedule } from "@/lib/nhl/schedule";

export interface TeamGameInfo {
  gameId: number;
  opponent: string;
  home: boolean;
  gameState: string;
  startTimeUTC: string;
}

/** date must be "YYYY-MM-DD". Team abbrev -> that team's game info for the day. */
export async function getTeamGamesForDate(date: string): Promise<Map<string, TeamGameInfo>> {
  const games = await getDaySchedule(date);
  const map = new Map<string, TeamGameInfo>();

  for (const g of games) {
    if (g.gameType !== 2) continue;
    map.set(g.awayTeam.abbrev, {
      gameId: g.id,
      opponent: g.homeTeam.abbrev,
      home: false,
      gameState: g.gameState,
      startTimeUTC: g.startTimeUTC,
    });
    map.set(g.homeTeam.abbrev, {
      gameId: g.id,
      opponent: g.awayTeam.abbrev,
      home: true,
      gameState: g.gameState,
      startTimeUTC: g.startTimeUTC,
    });
  }

  return map;
}

// DESIGN.md §2.4: "a player locks when his own game begins, nothing else" —
// compare wall-clock time against puck-drop, not gameState. gameState hits
// "PRE" a few minutes before puck drop, which would lock a player too early.
export function isLocked(game: TeamGameInfo, now: Date = new Date()): boolean {
  return now >= new Date(game.startTimeUTC);
}
