import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isLeagueCommissioner } from "@/lib/leagues/mutations";
import { LeagueNav } from "@/components/LeagueNav";

export default async function LeagueLayout(props: LayoutProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const myTeam = league.teams.find((t) => t.managerUserId === userId);
  const isCommissioner = await isLeagueCommissioner(id, userId);

  return (
    <div>
      <LeagueNav leagueId={id} myTeamId={myTeam?.id ?? null} isCommissioner={isCommissioner} />
      {props.children}
    </div>
  );
}
