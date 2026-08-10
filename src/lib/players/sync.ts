// Full-profile enrichment via team rosters. Game ingestion only creates cheap
// stubs (abbreviated name, no dob/org/careerNhlGp — see identity.ts). This
// fills those in properly, scoped to current NHL rosters.
//
// Concurrency matters here, not just for speed: the first production cron
// run did this fully sequentially (~800 landing fetches, one at a time) and
// blew straight through Vercel's serverless function time limit — 500 with
// no body, since the platform kills the function rather than letting it
// finish. Bounded concurrency keeps this comfortably inside the timeout.

import { getTeamRoster, NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { upsertPlayerFull } from "@/lib/players/identity";
import { runWithConcurrency } from "@/lib/concurrency";

const CONCURRENCY = 15;

export interface RosterSyncResult {
  team: string;
  playersSynced: number;
  failures: { playerId: number; error: string }[];
}

export async function syncTeamRoster(teamAbbrev: string): Promise<RosterSyncResult> {
  const roster = await getTeamRoster(teamAbbrev);
  const allPlayers = [...roster.forwards, ...roster.defensemen, ...roster.goalies];

  let playersSynced = 0;
  const failures: { playerId: number; error: string }[] = [];

  await runWithConcurrency(allPlayers, CONCURRENCY, async (p) => {
    try {
      await upsertPlayerFull(p.id);
      playersSynced += 1;
    } catch (e) {
      failures.push({ playerId: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return { team: teamAbbrev, playersSynced, failures };
}

// Teams are synced one at a time (not concurrently) — each team's roster
// already runs CONCURRENCY requests in parallel internally. Concurrent teams
// on top of that would multiply out to 225+ simultaneous requests, which is
// just being a bad citizen against a free, unauthenticated public API for no
// real speed benefit (the per-team concurrency already dominates the time).
async function syncRosters(teams: readonly string[]): Promise<RosterSyncResult[]> {
  const results: RosterSyncResult[] = [];
  for (const team of teams) {
    results.push(await syncTeamRoster(team));
  }
  return results;
}

export async function syncAllRosters(): Promise<RosterSyncResult[]> {
  return syncRosters(NHL_TEAM_ABBREVS);
}

/** Scoped sync — used by the daily cron so a quiet day (or even a full
 * slate) never has to touch all 32 teams' rosters, only the ones that
 * actually played. */
export async function syncTeamsRosters(teamAbbrevs: string[]): Promise<RosterSyncResult[]> {
  return syncRosters(teamAbbrevs);
}
