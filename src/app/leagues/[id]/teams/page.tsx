import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getRosterCounts, activeRosterCap } from "@/lib/rosters/mutations";
import { getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { Card, SectionLabel } from "@/components/Card";

export default async function OtherTeamsPage(props: PageProps<"/leagues/[id]/teams">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const settings = league.settingsJson as unknown as LeagueSettings;
  const cap = activeRosterCap(settings);
  const [rosterCounts, waiverPriority] = await Promise.all([
    getRosterCounts(league.teams.map((t) => t.id)),
    getOrInitWaiverPriority(id),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href={`/leagues/${id}`} className="text-sm text-muted hover:underline">
        ← {league.name}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Teams</h1>

      <div className="mt-6">
        <SectionLabel>All teams ({league.teams.length})</SectionLabel>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {league.teams.map((team) => {
            const isYou = isTeamManager(team, userId);
            const rosterCount = rosterCounts.get(team.id) ?? 0;
            const priorityIdx = waiverPriority.indexOf(team.id);
            return (
              <Link key={team.id} href={`/leagues/${id}/teams/${team.id}`}>
                <Card className={`transition-colors hover:border-blue ${isYou ? "border-gold" : ""}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{team.name}</p>
                    {isYou && (
                      <span className="rounded bg-gold px-1.5 py-0.5 text-[10px] font-semibold text-gold-foreground">
                        YOU
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    {rosterCount} / {cap} roster spots
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Waiver priority: {priorityIdx === -1 ? "not yet ranked" : `#${priorityIdx + 1}`}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
