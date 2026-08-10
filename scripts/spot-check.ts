import { prisma } from "@/lib/db";

async function main() {
  const line = await prisma.gameStatLine.findFirst({
    where: { player: { fullName: { contains: "McDavid" } } },
    include: { player: true },
    orderBy: { gameDate: "asc" },
  });
  console.log(JSON.stringify(line, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
