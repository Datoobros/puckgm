// One-time backfill of GameStatLine's new game-context columns
// (teamAbbrev/opponentAbbrev/isHome/teamScore/opponentScore/lastPeriodType)
// for rows ingested before those columns existed. Resumable and idempotent:
// re-running only re-ingests games that still have a null opponentAbbrev, and
// ingestGame is itself an upsert so it never duplicates rows. Doesn't touch
// syncAllRosters — this is purely a re-ingest of already-known games.
//
// Usage: npx tsx --env-file=.env scripts/backfill-game-context.ts

import { ingestGame } from "@/lib/ingest/games";
import { prisma } from "@/lib/db";
import { runWithConcurrency } from "@/lib/concurrency";

const CONCURRENCY = 10;

async function main() {
  const before = await prisma.gameStatLine.count({ where: { opponentAbbrev: null } });
  console.log(`Rows missing game context before backfill: ${before}`);

  const rows = await prisma.gameStatLine.findMany({
    where: { opponentAbbrev: null },
    distinct: ["gameId"],
    select: { gameId: true },
  });
  const gameIds = rows.map((r) => Number(r.gameId));
  console.log(`${gameIds.length} unique games to re-ingest.`);

  let done = 0;
  let ingested = 0;
  const errors: { gameId: number; error: string }[] = [];
  const start = Date.now();

  await runWithConcurrency(gameIds, CONCURRENCY, async (gameId) => {
    try {
      const result = await ingestGame(gameId);
      if (result.status === "ingested") ingested += 1;
    } catch (e) {
      errors.push({ gameId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      done += 1;
      if (done % 100 === 0 || done === gameIds.length) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`  ${done}/${gameIds.length} games processed (${elapsed}s elapsed)`);
      }
    }
  });

  console.log(`\nGames ingested: ${ingested}, errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log("Errors (first 10):", errors.slice(0, 10));
  }

  const after = await prisma.gameStatLine.count({ where: { opponentAbbrev: null } });
  console.log(`Rows missing game context after backfill: ${after}`);

  if (after !== 0) {
    console.error(`FAIL: ${after} rows still missing opponentAbbrev.`);
    process.exitCode = 1;
    return;
  }

  // Spot check against a known game, verified directly against the NHL API
  // (api-web.nhle.com/v1/gamecenter/2025020500/boxscore): MTL 4 @ NYR 5, OT.
  const spotGameId = "2025020500";
  const mtlLines = await prisma.gameStatLine.findMany({
    where: { gameId: spotGameId, teamAbbrev: "MTL" },
  });
  const nyrLines = await prisma.gameStatLine.findMany({
    where: { gameId: spotGameId, teamAbbrev: "NYR" },
  });

  const spotErrors: string[] = [];
  if (mtlLines.length === 0) spotErrors.push(`No MTL lines found for game ${spotGameId}`);
  if (nyrLines.length === 0) spotErrors.push(`No NYR lines found for game ${spotGameId}`);
  for (const line of mtlLines) {
    if (line.opponentAbbrev !== "NYR") spotErrors.push(`MTL line ${line.id}: opponentAbbrev=${line.opponentAbbrev}, expected NYR`);
    if (line.isHome !== false) spotErrors.push(`MTL line ${line.id}: isHome=${line.isHome}, expected false`);
    if (line.teamScore !== 4) spotErrors.push(`MTL line ${line.id}: teamScore=${line.teamScore}, expected 4`);
    if (line.opponentScore !== 5) spotErrors.push(`MTL line ${line.id}: opponentScore=${line.opponentScore}, expected 5`);
    if (line.lastPeriodType !== "OT") spotErrors.push(`MTL line ${line.id}: lastPeriodType=${line.lastPeriodType}, expected OT`);
  }
  for (const line of nyrLines) {
    if (line.opponentAbbrev !== "MTL") spotErrors.push(`NYR line ${line.id}: opponentAbbrev=${line.opponentAbbrev}, expected MTL`);
    if (line.isHome !== true) spotErrors.push(`NYR line ${line.id}: isHome=${line.isHome}, expected true`);
    if (line.teamScore !== 5) spotErrors.push(`NYR line ${line.id}: teamScore=${line.teamScore}, expected 5`);
    if (line.opponentScore !== 4) spotErrors.push(`NYR line ${line.id}: opponentScore=${line.opponentScore}, expected 4`);
    if (line.lastPeriodType !== "OT") spotErrors.push(`NYR line ${line.id}: lastPeriodType=${line.lastPeriodType}, expected OT`);
  }

  if (spotErrors.length > 0) {
    console.error("FAIL: spot check against game 2025020500 failed:");
    for (const err of spotErrors) console.error(`  ${err}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Spot check OK: game ${spotGameId} — ${mtlLines.length} MTL lines (away, 4-5) and ` +
      `${nyrLines.length} NYR lines (home, 5-4), all OT, mirror correctly.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
