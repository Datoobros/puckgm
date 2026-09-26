// Roster-scoped player enrichment. Game ingestion only creates cheap stubs
// (abbreviated name, no dob/org/headshot — see identity.ts's ensurePlayerStub).
// This fills those in properly from each team's roster payload, which turns
// out to carry everything a Player row needs except careerNhlGp (see
// upsertPlayerFromRoster's doc comment) — that field is refreshCareerGp's job
// now (src/lib/players/careerGp.ts), run as its own cron phase.
//
// This used to hit the NHL landing endpoint once per player — ~950 requests
// on a full-slate night. Reproduced live: the NHL API rate-limits IP-globally
// and stays limited for minutes once tripped, so a burst that size 429'd
// almost everything past the first team or two, and Task 1's retry backoff
// (500ms -> 1s -> 2s per failed call) just patiently waited on doomed
// requests instead of doing useful work — 120s of "roster sync" that mostly
// wasn't. One request per team (32 total) instead of one per player fixes
// the actual problem; see the ingest-reliability-batch plan's Task 4b.

import { getTeamRoster, NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { upsertPlayerFromRoster } from "@/lib/players/identity";
import { runWithConcurrency } from "@/lib/concurrency";
import { NhlRateLimitedError } from "@/lib/nhl/pacer";

// Teams fan out at this concurrency (not sequential, and not per-player
// anymore — see file header). Measured directly against the live NHL API:
// 3 stayed clean, 6 tripped the rate limit partway through a 32-team run.
const TEAM_CONCURRENCY = 3;

export interface RosterSyncResult {
  team: string;
  playersSynced: number;
  failures: { playerId: number; error: string }[];
  // True when the roster fetch itself failed (e.g. a 429) — kept separate
  // from per-player failures below. Conflating the two (both used to land
  // in the same `failures` array under a playerId: -1 sentinel) is what hid
  // the ~800-players-never-attempted bug Task 4b found: a team full of
  // "failures" looked the same whether one player failed or the whole
  // roster fetch never happened.
  rosterFetchFailed: boolean;
}

export async function syncTeamRoster(teamAbbrev: string): Promise<RosterSyncResult> {
  let roster;
  try {
    roster = await getTeamRoster(teamAbbrev);
  } catch (e) {
    // Rate-limited is not a per-team failure — rethrow so syncRosters below
    // can stop the whole fan-out instead of recording 32 misleading
    // "failed" teams. Any other error (a genuine one-team fetch problem)
    // still gets the sentinel/shape below.
    if (e instanceof NhlRateLimitedError) throw e;
    // playerId -1 preserves Task 2's original sentinel/shape for anything
    // still reading `failures` directly; `rosterFetchFailed` below is the
    // explicit signal new callers should check instead.
    return {
      team: teamAbbrev,
      playersSynced: 0,
      failures: [{ playerId: -1, error: e instanceof Error ? e.message : String(e) }],
      rosterFetchFailed: true,
    };
  }
  const allPlayers = [...roster.forwards, ...roster.defensemen, ...roster.goalies];

  let playersSynced = 0;
  const failures: { playerId: number; error: string }[] = [];

  // No network call per player anymore, just a DB upsert — plain
  // Promise.all is fine, nothing external to rate-limit here.
  await Promise.all(
    allPlayers.map(async (p) => {
      try {
        await upsertPlayerFromRoster(p, teamAbbrev);
        playersSynced += 1;
      } catch (e) {
        failures.push({ playerId: p.id, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return { team: teamAbbrev, playersSynced, failures, rosterFetchFailed: false };
}

export interface RosterSyncOutcome {
  results: RosterSyncResult[];
  // True when a real 429 tripped the shared pacer's circuit mid-fan-out.
  // Remaining teams are simply not attempted this run (see syncRosters) —
  // the next cron run picks them up, same idempotent-upsert story as
  // ingestDate's heal-forward window.
  rateLimited: boolean;
}

async function syncRosters(teams: readonly string[]): Promise<RosterSyncOutcome> {
  const results: RosterSyncResult[] = [];
  let rateLimited = false;

  await runWithConcurrency([...teams], TEAM_CONCURRENCY, async (team) => {
    // Fan-out already stopped this run — don't attempt more teams, don't
    // let more workers pile into an already-tripped circuit.
    if (rateLimited) return;
    try {
      results.push(await syncTeamRoster(team));
    } catch (e) {
      if (e instanceof NhlRateLimitedError) {
        rateLimited = true;
        return;
      }
      throw e;
    }
  });

  return { results, rateLimited };
}

export async function syncAllRosters(): Promise<RosterSyncOutcome> {
  return syncRosters(NHL_TEAM_ABBREVS);
}

/** Scoped sync — used by the daily cron so a quiet day (or even a full
 * slate) never has to touch all 32 teams' rosters, only the ones that
 * actually played. */
export async function syncTeamsRosters(teamAbbrevs: string[]): Promise<RosterSyncOutcome> {
  return syncRosters(teamAbbrevs);
}
