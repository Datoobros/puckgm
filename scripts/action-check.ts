import { prisma } from "@/lib/db";
import { createTeamAction, createLeagueAction } from "@/app/leagues/actions";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) throw new Error("Usage: tsx scripts/action-check.ts <leagueId>");

  console.log("-- calling createTeamAction with real FormData --");
  const fd = new FormData();
  fd.set("teamName", "Team Test-User-3 (via action)");

  try {
    await createTeamAction(leagueId, fd);
    console.log("action returned without redirecting (unexpected)");
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (digest?.startsWith("NEXT_REDIRECT")) {
      console.log("action redirected as expected:", digest);
    } else {
      console.log("action threw a REAL error:", e);
    }
  }

  const league = await prisma.league.findUnique({ where: { id: leagueId }, include: { teams: true } });
  console.log(`\nleague now has ${league?.teams.length} team(s):`, league?.teams.map((t) => t.name));
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
