import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { listLeagues, isTeamManager } from "@/lib/leagues/mutations";

export default async function LeaguesPage() {
  const { userId } = await auth.protect();
  const leagues = await listLeagues();

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Leagues</h1>
        <Link
          href="/leagues/new"
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground"
        >
          Create a league
        </Link>
      </div>

      {leagues.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No leagues yet — create the first one.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {leagues.map((league) => {
            const yourTeam = league.teams.find((t) => isTeamManager(t, userId));
            return (
              <li key={league.id} className="py-4">
                <Link href={`/leagues/${league.id}`} className="block">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{league.name}</span>
                    <span className="text-xs text-muted">
                      {league.seasonFounded}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {league.teams.length} team{league.teams.length === 1 ? "" : "s"}
                    {yourTeam ? ` — your team: ${yourTeam.name}` : " — not joined"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
