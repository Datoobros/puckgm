// Full-league backfill. Proven at small scale in backfill-team.ts — this is
// the same ingestGame() call, looped over every team's schedule with gameId
// deduplication (each game appears in both participants' schedules) and
// bounded concurrency so it doesn't take an hour running one request at a
// time.
//
// Usage: npx tsx --env-file=.env scripts/backfill-season.ts 20252026

import { getClubSchedule, NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { ingestGame } from "@/lib/ingest/games";
import { syncAllRosters } from "@/lib/players/sync";
import { prisma } from "@/lib/db";
import { runWithConcurrency } from "@/lib/concurrency";

const CONCURRENCY = 10;

async function main() {
  const season = Number(process.argv[2] ?? 20252026);

  console.log(`Fetching schedules for all ${NHL_TEAM_ABBREVS.length} teams, season ${season}...`);
  const gameIds = new Set<number>();
  for (const team of NHL_TEAM_ABBREVS) {
    const schedule = await getClubSchedule(team, season);
    for (const g of schedule.games) {
      if (g.gameType === 2 && g.gameState === "OFF") gameIds.add(g.id);
    }
  }
  const uniqueGames = [...gameIds];
  console.log(`${uniqueGames.length} unique final regular-season games to ingest.`);

  let done = 0;
  let ingested = 0;
  let totalLines = 0;
  const errors: { gameId: number; error: string }[] = [];
  const start = Date.now();

  await runWithConcurrency(uniqueGames, CONCURRENCY, async (gameId) => {
    try {
      const result = await ingestGame(gameId);
      if (result.status === "ingested") {
        ingested += 1;
        totalLines += result.playerLinesWritten;
      }
    } catch (e) {
      errors.push({ gameId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      done += 1;
      if (done % 100 === 0 || done === uniqueGames.length) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`  ${done}/${uniqueGames.length} games processed (${elapsed}s elapsed)`);
      }
    }
  });

  console.log(`\nGames ingested: ${ingested}, errors: ${errors.length}, stat lines written: ${totalLines}`);
  if (errors.length > 0) {
    console.log("Errors (first 10):", errors.slice(0, 10));
  }

  console.log("\nSyncing full rosters for all 32 teams (name/dob/org/careerNhlGp enrichment)...");
  const rosterResults = await syncAllRosters();
  const totalSynced = rosterResults.reduce((s, r) => s + r.playersSynced, 0);
  const totalFailed = rosterResults.reduce((s, r) => s + r.failures.length, 0);
  console.log(`Roster sync done — ${totalSynced} players synced, ${totalFailed} failures.`);

  const totalRows = await prisma.gameStatLine.count();
  const totalPlayers = await prisma.player.count();
  console.log(`\nFinal DB totals — GameStatLine rows: ${totalRows}, Player rows: ${totalPlayers}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
