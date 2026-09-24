import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isLeagueCommissioner, isTeamManager } from "@/lib/leagues/mutations";
import { LeagueNav } from "@/components/LeagueNav";
import { PlayerProfileProvider } from "@/components/player-profile/PlayerProfileProvider";

export default async function LeagueLayout(props: LayoutProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const myTeam = league.teams.find((t) => isTeamManager(t, userId));
  const isCommissioner = await isLeagueCommissioner(id, userId);

  return (
    <div>
      <LeagueNav leagueId={id} myTeamId={myTeam?.id ?? null} isCommissioner={isCommissioner} />
      <PlayerProfileProvider leagueId={id}>{props.children}</PlayerProfileProvider>
    </div>
  );
}
