import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeagueOwnershipMap } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { PlayerStatsTable } from "./PlayerStatsTable";

interface RosterContext {
  leagueId: string;
  teamId: string;
  isMyTeam: boolean;
}

async function resolveRosterContext(
  leagueId: string | undefined,
  teamId: string | undefined,
  userId: string,
): Promise<RosterContext | null> {
  if (!leagueId || !teamId) return null;
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || team.leagueId !== leagueId) return null;
  return { leagueId, teamId, isMyTeam: team.managerUserId === userId };
}

// Displayed pool is capped at 300 (by points) rather than shipping all
// ~1091 players to the client on every load — sort/filter/pagination all
// happen client-side against whatever's loaded, so this caps payload size,
// not functionality. Name search stays exhaustive across every player
// regardless of this cap, since it's a separate server-side query.
const DEFAULT_POOL_SIZE = 300;

export default async function PlayersPage(props: PageProps<"/players">) {
  const { userId } = await auth.protect();

  const params = await props.searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const rosterContext = await resolveRosterContext(
    typeof params.leagueId === "string" ? params.leagueId : undefined,
    typeof params.teamId === "string" ? params.teamId : undefined,
    userId,
  );

  let rows;
  if (query) {
    const matches = await prisma.player.findMany({
      where: { fullName: { contains: query, mode: "insensitive" } },
      select: { id: true },
      take: 50,
    });
    rows = await getPlayerStatsAggregate({ playerIds: matches.map((m) => m.id) });
  } else {
    rows = await getPlayerStatsAggregate({ limit: DEFAULT_POOL_SIZE });
  }

  const ownershipMap = rosterContext
    ? await getLeagueOwnershipMap(rosterContext.leagueId, rows.map((r) => r.id))
    : new Map<string, string>();
  const ownership = Object.fromEntries(ownershipMap);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
      <p className="mt-1 text-sm text-zinc-500">
        2025-26 season, raw stats ingested from NHL&apos;s API. Fantasy points
        use a starter scoring config (2/G, 1/A, 0.1/SOG, 4/W, 0.2/SV) —
        leagues will set their own values later.
        {!query && ` Showing top ${DEFAULT_POOL_SIZE} by points — search finds anyone.`}
      </p>
      {rosterContext && (
        <p className="mt-2 text-sm text-zinc-500">
          {rosterContext.isMyTeam
            ? "Adding players to your team."
            : "Viewing ownership only — this isn't your team."}
        </p>
      )}

      <form method="get" className="mt-4 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Player Name"
          className="flex-1 max-w-sm rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
        />
        {rosterContext && (
          <>
            <input type="hidden" name="leagueId" value={rosterContext.leagueId} />
            <input type="hidden" name="teamId" value={rosterContext.teamId} />
          </>
        )}
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
