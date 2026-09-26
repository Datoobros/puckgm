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
  | { kind: "ingested"; awayAbbrev: string; homeAbbrev: string; statLinesWritten: number }
  | { kind: "skipped" }
  | { kind: "error"; gameId: number; error: string };

export interface DailyIngestResult {
  date: string;
  gamesFound: number;
  gamesIngested: number;
  gamesSkipped: number;
  statLinesWritten: number;
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
          ? {
              kind: "ingested",
              awayAbbrev: g.awayTeam.abbrev,
              homeAbbrev: g.homeTeam.abbrev,
              statLinesWritten: result.playerLinesWritten,
            }
          : { kind: "skipped" };
      } catch (e) {
        return { kind: "error", gameId: g.id, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  let gamesIngested = 0;
  let statLinesWritten = 0;
  const errors: { gameId: number; error: string }[] = [];
  const teamsInvolved = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.kind === "ingested") {
      gamesIngested += 1;
      statLinesWritten += outcome.statLinesWritten;
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
    statLinesWritten,
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

// ingestDate above processes exactly one day and never looks back — nothing
// ever re-asks for a day once the cron has moved past it. That loses games
// permanently on any of: a missed cron run, a transient NHL API outage, or a
// West Coast game still sitting in FINAL rather than OFF at cron time (see
// ingestGame's OFF-only check). Walking this many days back each run heals
// all three for free: re-ingesting an already-complete day is a no-op
// idempotent upsert (GameStatLine is unique on (playerId, gameId)), so the
// only cost of the extra days is a handful of additional schedule-endpoint
// calls, not re-doing real work.
export const INGEST_HEAL_DAYS = 3;

/** The heal-forward window: yesterday, plus `days - 1` days further back. */
export function healForwardDates(days: number = INGEST_HEAL_DAYS): string[] {
  const base = yesterdayUTC();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export interface RecentIngestResult {
  datesAttempted: string[];
  dates: DailyIngestResult[];
  gamesFound: number;
  gamesIngested: number;
  gamesSkipped: number;
  statLinesWritten: number;
  errors: { date: string; gameId: number; error: string }[];
  teamsInvolved: string[];
}

/** Calls ingestDate once per day in the heal-forward window and merges the
 * results. Dates are walked sequentially, not fanned out — each ingestDate
 * call already fans out across that day's games at INGEST_CONCURRENCY, and
 * stacking multiple days of bursts on top of each other is the same mistake
 * Task 1 fixed for a single day. */
export async function ingestRecentDates(days: number = INGEST_HEAL_DAYS): Promise<RecentIngestResult> {
  const datesAttempted = healForwardDates(days);
  const dates: DailyIngestResult[] = [];
  for (const date of datesAttempted) {
    dates.push(await ingestDate(date));
  }

  let gamesFound = 0;
  let gamesIngested = 0;
  let gamesSkipped = 0;
  let statLinesWritten = 0;
  const errors: { date: string; gameId: number; error: string }[] = [];
  const teamsInvolved = new Set<string>();

  for (const r of dates) {
    gamesFound += r.gamesFound;
    gamesIngested += r.gamesIngested;
    gamesSkipped += r.gamesSkipped;
    statLinesWritten += r.statLinesWritten;
    for (const e of r.errors) errors.push({ date: r.date, ...e });
    for (const t of r.teamsInvolved) teamsInvolved.add(t);
  }

  return {
    datesAttempted,
    dates,
    gamesFound,
    gamesIngested,
    gamesSkipped,
    statLinesWritten,
    errors,
    teamsInvolved: [...teamsInvolved],
  };
}
