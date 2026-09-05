import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { getTeamsForUser, type LeagueSettings } from "@/lib/leagues/mutations";
import { getRosterCounts, activeRosterCap } from "@/lib/rosters/mutations";
import { Card, SectionLabel } from "@/components/Card";

export default async function Home() {
  const user = await currentUser();
  const teams = user ? await getTeamsForUser(user.id) : [];
  const rosterCounts = user ? await getRosterCounts(teams.map((t) => t.id)) : new Map<string, number>();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Show when="signed-out">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">puckgm</h1>
          <p className="max-w-md text-muted">
            Dynasty fantasy hockey GM sim. Early days — player stats and
            leagues are the first things built.
          </p>
          <p className="text-sm text-muted">Sign in above to get started.</p>
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <div className="flex gap-3 text-sm">
            <Link href="/leagues/new" className="text-muted hover:text-foreground hover:underline">
              Create a league
            </Link>
            <Link href="/leagues" className="text-muted hover:text-foreground hover:underline">
              Browse leagues
            </Link>
          </div>
        </div>

        {teams.length === 0 ? (
          <Card className="mt-6 flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted">You&apos;re not in any leagues yet.</p>
            <div className="flex gap-3">
              <Link
                href="/leagues/new"
                className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground"
              >
                Create a league
              </Link>
              <Link
                href="/leagues"
                className="rounded border border-border px-4 py-2 text-sm font-medium"
              >
                Browse leagues
              </Link>
            </div>
          </Card>
        ) : (
          <div className="mt-6">
            <SectionLabel>My Teams</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {teams.map((team) => {
                const settings = team.league.settingsJson as unknown as LeagueSettings;
                const cap = activeRosterCap(settings);
                const rosterCount = rosterCounts.get(team.id) ?? 0;
                return (
                  <Link key={team.id} href={`/leagues/${team.leagueId}/teams/${team.id}`}>
                    <Card className="transition-colors hover:border-blue">
                      <p className="text-xs text-muted">{team.league.name}</p>
                      <p className="mt-1 font-medium">{team.name}</p>
                      <p className="mt-2 text-xs text-muted">
                        {rosterCount} / {cap} roster spots
                      </p>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
