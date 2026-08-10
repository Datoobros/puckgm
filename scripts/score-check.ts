import { prisma } from "@/lib/db";
import { computePlayerPoints, STARTER_SCORING } from "@/lib/scoring/engine";

async function main() {
  const name = process.argv[2] ?? "McDavid";
  const player = await prisma.player.findFirst({ where: { fullName: { contains: name } } });
  if (!player) {
    console.log(`No player found matching "${name}"`);
    return;
  }
  const lineCount = await prisma.gameStatLine.count({ where: { playerId: player.id } });
  const points = await computePlayerPoints(player.id, STARTER_SCORING);
  console.log(`${player.fullName} (${player.primaryPosition}) — ${lineCount} games ingested, ${points.toFixed(1)} fantasy pts under STARTER_SCORING`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
