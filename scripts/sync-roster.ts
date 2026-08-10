// Usage: npx tsx --env-file=.env scripts/sync-roster.ts EDM
import { syncTeamRoster } from "@/lib/players/sync";
import { prisma } from "@/lib/db";

async function main() {
  const team = process.argv[2] ?? "EDM";
  const result = await syncTeamRoster(team);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
