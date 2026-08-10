// Game-level stat line ingestion. Stores raw stats only — fantasy points are
// always computed on read against a league's scoring config, never persisted
// here. This is deliberate: NHL official scorers reassign stats (e.g.
// assists) days after a game, and if points were baked in, a correction
// would silently desync history from reality. See DESIGN.md §4.1.
//
// Idempotent by design: GameStatLine is unique on (playerId, gameId), so
// re-ingesting a game updates existing rows rather than duplicating them.

import { prisma } from "@/lib/db";
import { ensurePlayerStub } from "@/lib/players/identity";
import { getBoxscore, type NhlBoxscorePlayer, type NhlBoxscoreTeam } from "@/lib/nhl/client";

export interface IngestResult {
  gameId: number;
  status: "ingested" | "skipped-not-final";
  playerLinesWritten: number;
}

function* teamPlayers(team: NhlBoxscoreTeam | undefined): Generator<NhlBoxscorePlayer> {
  if (!team) return;
  for (const p of team.forwards ?? []) yield p;
  for (const p of team.defense ?? []) yield p;
  for (const p of team.goalies ?? []) yield p;
}

export async function ingestGame(gameId: number): Promise<IngestResult> {
  const box = await getBoxscore(gameId);

  // Only ingest completed games — "FUT" (future) or "LIVE" (in progress)
  // stat lines aren't final and would need to be re-ingested anyway.
  if (box.gameState !== "OFF") {
    return { gameId, status: "skipped-not-final", playerLinesWritten: 0 };
  }

  const gameDate = new Date(box.gameDate);
  let written = 0;

  for (const team of [box.playerByGameStats?.awayTeam, box.playerByGameStats?.homeTeam]) {
    for (const p of teamPlayers(team)) {
      const internalPlayerId = await ensurePlayerStub(p.playerId, p.name.default, p.position);

      // Strip identity fields out of the stored payload — they live on
      // Player/PlayerSourceId, not duplicated into every stat line.
      const { playerId: _pid, name: _name, ...rawStats } = p;

      await prisma.gameStatLine.upsert({
        where: { playerId_gameId: { playerId: internalPlayerId, gameId: String(gameId) } },
        create: {
          playerId: internalPlayerId,
          gameId: String(gameId),
          gameDate,
          statsJson: rawStats as object,
        },
        update: {
          gameDate,
          statsJson: rawStats as object,
        },
      });
      written += 1;
    }
  }

  return { gameId, status: "ingested", playerLinesWritten: written };
}
