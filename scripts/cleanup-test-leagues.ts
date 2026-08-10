import { prisma } from "@/lib/db";

async function main() {
  const testLeagues = await prisma.league.findMany({
    where: { name: { in: ["Visual Test League", "Action-Created League", "Test League (delete me)"] } },
  });
  for (const league of testLeagues) {
    await prisma.team.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.delete({ where: { id: league.id } });
    console.log("deleted:", league.name);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
