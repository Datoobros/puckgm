// Daily ingestion — the scheduled counterpart to scripts/backfill-season.ts.
// Uses the league-wide schedule-by-date endpoint (one request finds every
// game across all 32 teams for a given day) rather than looping team
// schedules, since a daily job only needs one day's slate.

import { ingestGame } from "@/lib/ingest/games";
import { getDaySchedule } from "@/lib/nhl/schedule";

export interface DailyIngestResult {
  date: string;
  gamesFound: number;
  gamesIngested: number;
  gamesSkipped: number;
  errors: { gameId: number; error: string }[];
  /** Teams involved in that day's ingested games — feeds the scoped roster
   * sync so a quiet day (or even a full slate) never has to touch all 32
   * teams, only the ones that actually played. */
  teamsInvolved: string[];
}

/** date must be "YYYY-MM-DD". */
export async function ingestDate(date: string): Promise<DailyIngestResult> {
  const games = await getDaySchedule(date);

  let gamesIngested = 0;
  let gamesSkipped = 0;
  const errors: { gameId: number; error: string }[] = [];
  const teamsInvolved = new Set<string>();

  for (const g of games) {
    // Regular season only for now — playoffs (gameType 3) are Stage 6+
    // territory once the league's actually running.
    if (g.gameType !== 2 || g.gameState !== "OFF") {
      gamesSkipped += 1;
      continue;
    }
    try {
      const result = await ingestGame(g.id);
      if (result.status === "ingested") {
        gamesIngested += 1;
        teamsInvolved.add(g.awayTeam.abbrev);
        teamsInvolved.add(g.homeTeam.abbrev);
      } else {
        gamesSkipped += 1;
      }
    } catch (e) {
      errors.push({ gameId: g.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    date,
    gamesFound: games.length,
    gamesIngested,
    gamesSkipped,
    errors,
    teamsInvolved: [...teamsInvolved],
  };
}

/** Yesterday's date in UTC, formatted YYYY-MM-DD.
 *
 * Approximation: NHL games are dated by their local (mostly ET) start date.
 * A cron run timed at ~4am ET safely covers every game that started the
 * previous ET calendar day, but computing "yesterday" from server UTC time
 * rather than true ET means the boundary is only exact if the cron itself
 * runs comfortably after ET midnight — which a 4am ET schedule does. Revisit
 * with a proper timezone lib if the cron schedule ever moves closer to the
 * boundary.
 */
export function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
