// Full-profile enrichment via team rosters. Game ingestion only creates cheap
// stubs (abbreviated name, no dob/org/careerNhlGp — see identity.ts). This
// fills those in properly, scoped to current NHL rosters. Cheap enough to run
// daily: 32 roster fetches + one landing fetch per active player (~700-800
// total), vs. the alternative of fetching full landing per player per game.

import { getTeamRoster, NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { upsertPlayerFull } from "@/lib/players/identity";

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

  for (const p of allPlayers) {
    try {
      await upsertPlayerFull(p.id);
      playersSynced += 1;
    } catch (e) {
      failures.push({ playerId: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { team: teamAbbrev, playersSynced, failures };
}

export async function syncAllRosters(): Promise<RosterSyncResult[]> {
  const results: RosterSyncResult[] = [];
  for (const team of NHL_TEAM_ABBREVS) {
    results.push(await syncTeamRoster(team));
  }
  return results;
}
