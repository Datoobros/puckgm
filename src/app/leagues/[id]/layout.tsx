import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner } from "@/lib/leagues/mutations";
import { LeagueNav } from "@/components/LeagueNav";

export default async function LeagueLayout(props: LayoutProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const myTeam = league.teams.find((t) => t.managerUserId === userId);
  const commissioner = await getLeagueCommissioner(id);

  return (
    <div>
      <LeagueNav leagueId={id} myTeamId={myTeam?.id ?? null} isCommissioner={commissioner === userId} />
      {props.children}
    </div>
  );
}
