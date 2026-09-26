// Daily ingestion — the scheduled counterpart to scripts/backfill-season.ts.
// Uses the league-wide schedule-by-date endpoint (one request finds every
// game across all 32 teams for a given day) rather than looping team
// schedules, since a daily job only needs one day's slate.

import { ingestGame } from "@/lib/ingest/games";
import { getDaySchedule, type NhlScheduleGame } from "@/lib/nhl/schedule";
import { runWithConcurrency } from "@/lib/concurrency";

// Deliberate, not just "as fast as possible": syncTeamRoster already bursts
// 15 requests per team, and the live 429 on /roster/STL/current came from
// stacking those bursts on top of ingestion traffic. Keeping total in-flight
// requests modest here is being a reasonable citizen against a free,
// unauthenticated public API.
const INGEST_CONCURRENCY = 6;

type GameIngestOutcome =
  | { kind: "ingested"; awayAbbrev: string; homeAbbrev: string }
  | { kind: "skipped" }
  | { kind: "error"; gameId: number; error: string };

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

  // Regular season only for now — playoffs (gameType 3) are Stage 6+
  // territory once the league's actually running.
  const candidates: NhlScheduleGame[] = [];
  let gamesSkipped = 0;
  for (const g of games) {
    if (g.gameType === 2 && g.gameState === "OFF") {
      candidates.push(g);
    } else {
      gamesSkipped += 1;
    }
  }

  // Fan out with bounded concurrency instead of looping sequentially — a
  // 16-game slate measured 75s one game at a time locally, uncomfortably
  // close to Vercel's 60s function limit. Each worker returns its own
  // outcome rather than mutating shared counters, since counters written
  // from concurrent callbacks would race.
  const outcomes = await runWithConcurrency<NhlScheduleGame, GameIngestOutcome>(
    candidates,
    INGEST_CONCURRENCY,
    async (g): Promise<GameIngestOutcome> => {
      try {
        const result = await ingestGame(g.id);
        return result.status === "ingested"
          ? { kind: "ingested", awayAbbrev: g.awayTeam.abbrev, homeAbbrev: g.homeTeam.abbrev }
          : { kind: "skipped" };
      } catch (e) {
        return { kind: "error", gameId: g.id, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  let gamesIngested = 0;
  const errors: { gameId: number; error: string }[] = [];
  const teamsInvolved = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.kind === "ingested") {
      gamesIngested += 1;
      teamsInvolved.add(outcome.awayAbbrev);
      teamsInvolved.add(outcome.homeAbbrev);
    } else if (outcome.kind === "skipped") {
      gamesSkipped += 1;
    } else {
      errors.push({ gameId: outcome.gameId, error: outcome.error });
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
