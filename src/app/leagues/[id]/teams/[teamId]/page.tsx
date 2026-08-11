import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { Card, SectionLabel } from "@/components/Card";
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
    <div className="mx-auto max-w-4xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-zinc-500 hover:underline">
        ← {team.league.name}
      </Link>
      <div className="mt-1 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {roster.length} / {cap} active roster spots
          </p>
        </div>
        {isOwner && (
          <Link
            href={`/players?leagueId=${leagueId}&teamId=${teamId}`}
            className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Add players
          </Link>
        )}
      </div>

      <div className="mt-6">
        <SectionLabel>Roster</SectionLabel>
        {roster.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">No players rostered yet.</p>
          </Card>
        ) : (
          <Card className="overflow-hidden !p-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
                  <th className="py-2 pl-4 font-medium">Pos</th>
                  <th className="py-2 font-medium">Name</th>
                  <th className="py-2 font-medium">Org</th>
                  {isOwner && <th className="py-2 pr-4" />}
                </tr>
              </thead>
              <tbody>
                {roster.map((slot, i) => (
                  <tr
                    key={slot.id}
                    className={`border-b border-black/5 last:border-0 dark:border-white/5 ${
                      i % 2 === 1 ? "bg-black/[.015] dark:bg-white/[.02]" : ""
                    }`}
                  >
                    <td className="py-2 pl-4">
                      <span className="inline-block rounded border border-black/10 px-1.5 py-0.5 text-xs font-semibold text-zinc-500 dark:border-white/15">
                        {slot.player.primaryPosition ?? "—"}
                      </span>
                    </td>
                    <td className="py-2 font-medium">{slot.player.fullName}</td>
                    <td className="py-2 text-zinc-500">{slot.player.currentNhlOrg ?? "—"}</td>
                    {isOwner && (
                      <td className="py-2 pr-4 text-right">
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
          </Card>
        )}
      </div>
    </div>
  );
}
