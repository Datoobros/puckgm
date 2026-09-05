// Ingests one real NHL Entry Draft class as name/org/position-only Player
// stubs (src/lib/players/draftClass.ts) — run once a year, after the real
// draft happens (late June), or anytime against a past year to backfill/test.
// Idempotent — re-running the same year is a no-op (playersCreated: 0).
//
// Usage: npx tsx --env-file=.env scripts/ingest-draft-class.ts 2025

import { ingestDraftClass } from "@/lib/players/draftClass";
import { prisma } from "@/lib/db";

async function main() {
  const year = Number(process.argv[2]);
  if (!year) {
    throw new Error("Usage: npx tsx scripts/ingest-draft-class.ts <year>");
  }

  console.log(`Fetching the ${year} NHL Entry Draft class...`);
  const result = await ingestDraftClass(year);
  console.log(`Picks seen: ${result.picksSeen}, players created: ${result.playersCreated}`);

  const totalForYear = await prisma.player.count({ where: { draftYear: year } });
  console.log(`Total Player rows tagged draftYear=${year}: ${totalForYear}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
