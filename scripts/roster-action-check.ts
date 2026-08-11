import { prisma } from "@/lib/db";
import { createLeague } from "@/lib/leagues/mutations";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import { addPlayerAction } from "@/app/leagues/[id]/players/actions";
import { dropPlayerAction } from "@/app/leagues/[id]/teams/[teamId]/actions";

async function main() {
  const { leagueId, teamId } = await createLeague({
    name: "Roster Action Test League (delete me)",
    season: 2027,
    managerUserId: "roster-test-1",
    teamName: "Action Team",
    rosterComposition: { C: 2, LW: 2, RW: 2, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });

  const mcdavid = await prisma.player.findFirstOrThrow({ where: { fullName: "Connor McDavid" } });

  // revalidatePath() requires a real Next.js request context and throws
  // "static generation store missing" when called from a bare script — that
  // happens strictly after the real mutation, so it's expected here and
  // tolerated. redirect()'s NEXT_REDIRECT is the same category of thing.
  async function callOutsideRequestContext(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if (e instanceof Error && e.message.includes("static generation store missing")) return;
      throw e;
    }
  }

  console.log("-- calling the real addPlayerAction (Server Action, not the lib function) --");
  await callOutsideRequestContext(() => addPlayerAction(leagueId, teamId, mcdavid.id));
  const afterAdd = await getTeamRosterView(teamId);
  console.log("roster after action:", afterAdd.map((s) => s.player.fullName));

  console.log("\n-- calling the real dropPlayerAction --");
  await callOutsideRequestContext(() => dropPlayerAction(leagueId, teamId, mcdavid.id));
  const afterDrop = await getTeamRosterView(teamId);
  console.log("roster after action:", afterDrop.length, "players");

  console.log("\n-- cleanup --");
  await prisma.transactionLog.deleteMany({ where: { leagueId } });
  await prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } });
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  console.log("cleaned up");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
