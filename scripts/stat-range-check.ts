// Read-only verification for Task 1 (stat range dropdown, plans/team-page-batch.md).
// No test data created or deleted — just reads real ingested GameStatLine rows.
import { prisma } from "@/lib/db";
import { resolveStatRange } from "@/lib/players/seasons";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { STARTER_SCORING } from "@/lib/scoring/engine";

async function main() {
  // Last real ingested game date, per PROGRESS.md's Task 3 planning note —
  // anchoring here means last7/last30 windows actually contain real data.
  const anchor = "2026-04-16";

  const recentLines = await prisma.gameStatLine.findMany({
    where: { gameDate: { lte: new Date(`${anchor}T23:59:59.999Z`) } },
    orderBy: { gameDate: "desc" },
    take: 20,
    select: { playerId: true },
  });
  const playerIds = [...new Set(recentLines.map((l) => l.playerId))].slice(0, 5);
  if (playerIds.length === 0) {
    throw new Error(`No GameStatLine rows found on/before ${anchor} — can't verify against real data.`);
  }

  const last7 = resolveStatRange("last7", anchor);
  const last30 = resolveStatRange("last30", anchor);
  if (!last7 || !last30) throw new Error("resolveStatRange returned undefined for a known value ('last7'/'last30').");

  const [rows7, rows30] = await Promise.all([
    getPlayerStatsAggregate({ playerIds, scoringConfig: STARTER_SCORING, dateRange: last7 }),
    getPlayerStatsAggregate({ playerIds, scoringConfig: STARTER_SCORING, dateRange: last30 }),
  ]);

  const gp7 = new Map(rows7.map((r) => [r.id, r.gamesIngested]));
  const gp30 = new Map(rows30.map((r) => [r.id, r.gamesIngested]));

  if (!rows7.some((r) => r.gamesIngested > 0)) {
    throw new Error(`Expected at least one player with games in the last7 window anchored at ${anchor}; got all zero.`);
  }
  for (const id of playerIds) {
    const g7 = gp7.get(id) ?? 0;
    const g30 = gp30.get(id) ?? 0;
    if (g7 > g30) {
      throw new Error(`Player ${id}: last7 gamesIngested (${g7}) exceeds last30 (${g30}) — rolling windows are inconsistent.`);
    }
  }
  console.log(
    `OK: anchored at ${anchor} — ${playerIds.length} players checked, at least one non-zero in last7, ` +
      `last7 gamesIngested <= last30 gamesIngested for all.`,
  );

  // Offseason case (today is well past the last ingested game): should
  // resolve and query cleanly with all-zero rows, not throw.
  const futureAnchor = "2026-09-16";
  const futureRange = resolveStatRange("last7", futureAnchor);
  if (!futureRange) throw new Error("resolveStatRange returned undefined for last7 with a future anchor.");
  const futureRows = await getPlayerStatsAggregate({ playerIds, scoringConfig: STARTER_SCORING, dateRange: futureRange });
  if (!futureRows.every((r) => r.gamesIngested === 0)) {
    throw new Error(`Expected all-zero rows for last7 anchored at ${futureAnchor} (offseason); got some non-zero.`);
  }
  console.log(`OK: last7 anchored at ${futureAnchor} (offseason) — all ${futureRows.length} rows zero, no throw.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
