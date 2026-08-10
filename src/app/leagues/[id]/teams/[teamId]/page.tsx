import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { dropPlayerAction } from "./actions";

export default async function TeamRosterPage(props: PageProps<"/leagues/[id]/teams/[teamId]">) {
  const { userId } = await auth.protect();
  const { id: leagueId, teamId } = await props.params;

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== leagueId) notFound();

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = Object.values(settings.rosterComposition).reduce((sum, n) => sum + n, 0);
  const roster = await getTeamRosterView(teamId);
  const isOwner = team.managerUserId === userId;

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <p className="text-sm text-zinc-500">
        <Link href={`/leagues/${leagueId}`}>{team.league.name}</Link>
      </p>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
        {isOwner && (
          <Link
            href={`/players?leagueId=${leagueId}&teamId=${teamId}`}
            className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Add players
          </Link>
        )}
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {roster.length} / {cap} active roster spots
      </p>

      {roster.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">No players rostered yet.</p>
      ) : (
        <table className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Pos</th>
              <th className="py-2 font-medium">Org</th>
              {isOwner && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {roster.map((slot) => (
              <tr key={slot.id} className="border-b border-black/5 dark:border-white/5">
                <td className="py-2">{slot.player.fullName}</td>
                <td className="py-2 text-zinc-500">{slot.player.primaryPosition ?? "—"}</td>
                <td className="py-2 text-zinc-500">{slot.player.currentNhlOrg ?? "—"}</td>
                {isOwner && (
                  <td className="py-2 text-right">
                    <form action={dropPlayerAction.bind(null, leagueId, teamId, slot.playerId)}>
                      <button type="submit" className="text-xs text-zinc-500 underline">
                        Drop
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
