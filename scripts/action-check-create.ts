import { prisma } from "@/lib/db";
import { createLeagueAction } from "@/app/leagues/actions";

async function main() {
  const fd = new FormData();
  fd.set("name", "Action-Created League");
  fd.set("season", "2027");
  fd.set("teamName", "Founder Team");
  fd.set("posC", "3");
  fd.set("posLW", "2");
  fd.set("posRW", "2");
  fd.set("posD", "5");
  fd.set("posG", "2");
  fd.set("posUTIL", "1");
  fd.set("posBENCH", "7");
  fd.set("farmSlots", "8");
  fd.set("irSlots", "3");

  let redirectPath: string | undefined;
  try {
    await createLeagueAction(fd);
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (digest?.startsWith("NEXT_REDIRECT")) {
      redirectPath = digest.split(";")[2];
      console.log("redirected to:", redirectPath);
    } else {
      throw e;
    }
  }

  const leagueId = redirectPath?.split("/").pop();
  const league = await prisma.league.findUnique({ where: { id: leagueId }, include: { teams: true } });
  console.log(JSON.stringify(league, null, 2));
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
