import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { getTeamsForUser, type LeagueSettings } from "@/lib/leagues/mutations";
import { getRosterCounts } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { Card, SectionLabel } from "@/components/Card";

export default async function Home() {
  const user = await currentUser();
  const teams = user ? await getTeamsForUser(user.id) : [];
  const rosterCounts = user ? await getRosterCounts(teams.map((t) => t.id)) : new Map<string, number>();
  const topPlayers = user ? await getPlayerStatsAggregate({ limit: 5 }) : [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Show when="signed-out">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">puckgm</h1>
          <p className="max-w-md text-zinc-600 dark:text-zinc-400">
            Dynasty fantasy hockey GM sim. Early days — player stats and
            leagues are the first things built.
          </p>
          <p className="text-sm text-zinc-500">Sign in above to get started.</p>
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <div className="flex gap-3 text-sm">
            <Link href="/leagues/new" className="text-zinc-500 hover:text-foreground hover:underline">
              Create a league
            </Link>
            <Link href="/leagues" className="text-zinc-500 hover:text-foreground hover:underline">
              Browse leagues
            </Link>
          </div>
        </div>

        {teams.length === 0 ? (
          <Card className="mt-6 flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-zinc-500">You&apos;re not in any leagues yet.</p>
            <div className="flex gap-3">
              <Link
                href="/leagues/new"
                className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
              >
                Create a league
              </Link>
              <Link
                href="/leagues"
                className="rounded border border-black/10 px-4 py-2 text-sm font-medium dark:border-white/15"
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
                const cap = Object.values(settings.rosterComposition).reduce((s, n) => s + n, 0);
                const rosterCount = rosterCounts.get(team.id) ?? 0;
                return (
                  <Link key={team.id} href={`/leagues/${team.leagueId}/teams/${team.id}`}>
                    <Card className="transition-colors hover:border-black/25 dark:hover:border-white/25">
                      <p className="text-xs text-zinc-500">{team.league.name}</p>
                      <p className="mt-1 font-medium">{team.name}</p>
                      <p className="mt-2 text-xs text-zinc-500">
                        {rosterCount} / {cap} roster spots
                      </p>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {topPlayers.length > 0 && (
          <div className="mt-8">
            <SectionLabel>Top Players (2025-26 fantasy points)</SectionLabel>
            <Card>
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {topPlayers.map((p, i) => (
                  <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <span className="mr-2 text-zinc-500">{i + 1}.</span>
                      {p.fullName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {p.primaryPosition} · {p.currentNhlOrg ?? "—"}
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">{p.points.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
              <Link href="/players" className="mt-3 block text-xs text-zinc-500 hover:underline">
                See all players →
              </Link>
            </Card>
          </div>
        )}
      </Show>
    </div>
  );
}
