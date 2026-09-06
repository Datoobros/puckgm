import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getTeamSchedule } from "@/lib/matchups/standings";
import { TeamScheduleList } from "@/components/TeamScheduleList";

export default async function TeamSchedulePage(props: PageProps<"/leagues/[id]/teams/[teamId]/schedule">) {
  await auth.protect();
  const { id: leagueId, teamId } = await props.params;

  const team = await prisma.team.findUnique({ where: { id: teamId }, include: { league: true } });
  if (!team || team.leagueId !== leagueId) notFound();

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const rows = await getTeamSchedule(teamId, leagueId, team.league.currentSeason, settings.scoringConfig);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/teams/${teamId}`} className="text-sm text-muted hover:underline">
        ← {team.name}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{team.name}&apos;s Schedule</h1>
      <p className="mt-1 text-sm text-muted">
        {team.league.currentSeason}-{(team.league.currentSeason + 1) % 100} season
      </p>

      <div className="mt-6">
        <TeamScheduleList leagueId={leagueId} rows={rows} />
      </div>
    </div>
  );
}
