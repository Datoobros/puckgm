import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getLeagueOwnershipMap } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { PlayerStatsTable } from "./PlayerStatsTable";

// Displayed pool is capped rather than shipping every player to the client
// on every load — sort/filter/pagination all happen client-side against
// whatever's loaded, so this bounds payload size, not functionality. Name
// search stays exhaustive across every player regardless of this cap.
const DEFAULT_POOL_SIZE = 300;

export default async function LeaguePlayersPage(props: PageProps<"/leagues/[id]/players">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const params = await props.searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => t.managerUserId === userId);

  let rows;
  if (query) {
    const matches = await prisma.player.findMany({
      where: { fullName: { contains: query, mode: "insensitive" } },
      select: { id: true },
      take: 50,
    });
    rows = await getPlayerStatsAggregate({
      playerIds: matches.map((m) => m.id),
      scoringConfig: settings.scoringConfig,
    });
  } else {
    rows = await getPlayerStatsAggregate({
      limit: DEFAULT_POOL_SIZE,
      scoringConfig: settings.scoringConfig,
    });
  }

  const ownershipMap = await getLeagueOwnershipMap(leagueId, rows.map((r) => r.id));
  const ownership = Object.fromEntries(ownershipMap);
  const rosterContext = myTeam ? { leagueId, teamId: myTeam.id, isMyTeam: true } : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {league.name}&apos;s scoring, 2025-26 season stats.
        {!query && ` Showing top ${DEFAULT_POOL_SIZE} by points — search finds anyone.`}
      </p>
      {!myTeam && (
        <p className="mt-2 text-sm text-zinc-500">
          You don&apos;t have a team in this league — viewing ownership only.
        </p>
      )}

      <form method="get" className="mt-4 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Player Name"
          className="max-w-sm flex-1 rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
        />
        <button
          type="submit"
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Search
        </button>
      </form>

      <div className="mt-6">
        <PlayerStatsTable rows={rows} rosterContext={rosterContext} ownership={ownership} />
      </div>
    </div>
  );
}
