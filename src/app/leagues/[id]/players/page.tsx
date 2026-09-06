import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getLeagueOwnershipMap } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { getAvailableBudget, getMyPendingBids } from "@/lib/faab/mutations";
import { PlayerStatsTable } from "./PlayerStatsTable";
import { PlayerSearchBox } from "./PlayerSearchBox";
import { cancelFaBidAction } from "./actions";

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
  const myTeam = league.teams.find((t) => isTeamManager(t, userId));

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

  const [availableFaab, myPendingBids] =
    myTeam && settings.faabEnabled
      ? await Promise.all([
          getAvailableBudget(myTeam.id, league.currentSeason, settings.faabBudget),
          getMyPendingBids(leagueId, myTeam.id),
        ])
      : [null, []];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
      <p className="mt-1 text-sm text-muted">
        {league.name}&apos;s scoring, 2025-26 season stats.
        {!query && ` Showing top ${DEFAULT_POOL_SIZE} by points — search finds anyone.`}
      </p>
      {!myTeam && (
        <p className="mt-2 text-sm text-muted">
          You don&apos;t have a team in this league — viewing ownership only.
        </p>
      )}

      <div className="mt-4">
        <PlayerSearchBox initialQuery={query} />
      </div>

      {settings.faabEnabled && myTeam && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm">
          <p>
            FAAB available: <span className="font-medium">${availableFaab}</span>
            {settings.faabMaxBid !== null && (
              <span className="text-muted"> · max bid ${settings.faabMaxBid}</span>
            )}
            <span className="text-muted"> · min bid ${settings.faabMinBid}</span>
          </p>
          {myPendingBids.length > 0 && (
            <ul className="mt-2 space-y-1">
              {myPendingBids.map((bid) => (
                <li key={bid.id} className="flex items-center justify-between text-xs text-muted">
                  <span>
                    ${bid.amount} on {bid.playerName} → {bid.targetSlot === "ACTIVE" ? "Active" : "Farm"}
                  </span>
                  <form action={cancelFaBidAction.bind(null, leagueId, bid.id)}>
                    <button type="submit" className="underline hover:text-foreground">
                      Cancel
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-6">
        <PlayerStatsTable
          rows={rows}
          rosterContext={rosterContext}
          ownership={ownership}
          faab={
            settings.faabEnabled
              ? { minBid: settings.faabMinBid, maxBid: settings.faabMaxBid, pendingPlayerIds: myPendingBids.map((b) => b.playerId) }
              : null
          }
        />
      </div>
    </div>
  );
}
