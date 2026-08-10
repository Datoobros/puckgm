// Proof-of-concept backfill scoped to one team, per ROADMAP.md Stage 1
// Week 3-4. Full 32-team backfill is scripts/backfill-season.ts (later, once
// this is proven — same ingestGame() call, just looped over
// NHL_TEAM_ABBREVS with gameId dedup since every game appears in two teams'
// schedules).
//
// Usage: npx tsx scripts/backfill-team.ts EDM 20252026

import { getClubSchedule } from "@/lib/nhl/client";
import { ingestGame } from "@/lib/ingest/games";
import { prisma } from "@/lib/db";

async function main() {
  const team = process.argv[2] ?? "EDM";
  const season = Number(process.argv[3] ?? 20252026);

  console.log(`Fetching ${team} schedule for season ${season}...`);
  const schedule = await getClubSchedule(team, season);
  const finalGames = schedule.games.filter(
    (g) => g.gameType === 2 && g.gameState === "OFF",
  );
  console.log(`${schedule.games.length} total games, ${finalGames.length} final regular-season games.`);

  let ingested = 0;
  let skipped = 0;
  let linesWritten = 0;

  for (const g of finalGames) {
    const result = await ingestGame(g.id);
    if (result.status === "ingested") {
      ingested += 1;
      linesWritten += result.playerLinesWritten;
    } else {
      skipped += 1;
    }
  }

  console.log(`\nDone. Games ingested: ${ingested}, skipped (not final): ${skipped}, player-game lines written: ${linesWritten}`);

  const totalRows = await prisma.gameStatLine.count();
  const totalPlayers = await prisma.player.count();
  console.log(`DB totals — GameStatLine rows: ${totalRows}, Player rows: ${totalPlayers}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
