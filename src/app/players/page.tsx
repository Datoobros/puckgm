import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { computePlayerPoints, STARTER_SCORING } from "@/lib/scoring/engine";
import { getLeagueOwnershipMap } from "@/lib/rosters/mutations";
import { addPlayerAction } from "./actions";

async function searchResults(query: string) {
  const players = await prisma.player.findMany({
    where: { fullName: { contains: query, mode: "insensitive" } },
    take: 20,
    orderBy: { careerNhlGp: "desc" },
  });

  const withStats = await Promise.all(
    players.map(async (p) => {
      const [gamesIngested, points] = await Promise.all([
        prisma.gameStatLine.count({ where: { playerId: p.id } }),
        computePlayerPoints(p.id, STARTER_SCORING),
      ]);
      return { ...p, gamesIngested, points };
    }),
  );

  return withStats.sort((a, b) => b.points - a.points);
}

async function defaultList() {
  return prisma.player.findMany({
    orderBy: { careerNhlGp: "desc" },
    take: 20,
  });
}

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

export default async function PlayersPage(props: PageProps<"/players">) {
  const { userId } = await auth.protect();

  const params = await props.searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const rosterContext = await resolveRosterContext(
    typeof params.leagueId === "string" ? params.leagueId : undefined,
    typeof params.teamId === "string" ? params.teamId : undefined,
    userId,
  );

  const results = query ? await searchResults(query) : null;
  const notable = query ? null : await defaultList();

  const shownIds = (results ?? notable ?? []).map((p) => p.id);
  const ownership = rosterContext
    ? await getLeagueOwnershipMap(rosterContext.leagueId, shownIds)
    : new Map<string, string>();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
      <p className="mt-1 text-sm text-zinc-500">
        2025-26 season, raw stats ingested from NHL&apos;s API. Points shown use a
        starter scoring config (2/G, 1/A, 0.1/SOG, 4/W, 0.2/SV) — leagues will
        set their own values later.
      </p>
      {rosterContext && (
        <p className="mt-2 text-sm text-zinc-500">
          {rosterContext.isMyTeam
            ? "Adding players to your team."
            : "Viewing ownership only — this isn't your team."}
        </p>
      )}

      <form method="get" className="mt-6 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search a player..."
          className="flex-1 rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
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

      <div className="mt-8">
        {results && (
          <>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">
              {results.length} result{results.length === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
            </h2>
            <PlayerTable
              rows={results.map((p) => ({
                id: p.id,
                fullName: p.fullName,
                position: p.primaryPosition,
                org: p.currentNhlOrg,
                careerNhlGp: p.careerNhlGp,
                gamesIngested: p.gamesIngested,
                points: p.points,
              }))}
              rosterContext={rosterContext}
              ownership={ownership}
            />
          </>
        )}

        {notable && (
          <>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">
              Notable names (by career NHL games played)
            </h2>
            <PlayerTable
              rows={notable.map((p) => ({
                id: p.id,
                fullName: p.fullName,
                position: p.primaryPosition,
                org: p.currentNhlOrg,
                careerNhlGp: p.careerNhlGp,
                gamesIngested: null,
                points: null,
              }))}
              rosterContext={rosterContext}
              ownership={ownership}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface PlayerRow {
  id: string;
  fullName: string;
  position: string | null;
  org: string | null;
  careerNhlGp: number;
  gamesIngested: number | null;
  points: number | null;
}

function PlayerTable({
  rows,
  rosterContext,
  ownership,
}: {
  rows: PlayerRow[];
  rosterContext: RosterContext | null;
  ownership: Map<string, string>;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No players found.</p>;
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
          <th className="py-2 font-medium">Name</th>
          <th className="py-2 font-medium">Pos</th>
          <th className="py-2 font-medium">Org</th>
          <th className="py-2 font-medium text-right">Career GP</th>
          {rows[0].points !== null && (
            <>
              <th className="py-2 font-medium text-right">2025-26 GP</th>
              <th className="py-2 font-medium text-right">Pts</th>
            </>
          )}
          {rosterContext && <th className="py-2" />}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} className="border-b border-black/5 dark:border-white/5">
            <td className="py-2">{p.fullName}</td>
            <td className="py-2 text-zinc-500">{p.position ?? "—"}</td>
            <td className="py-2 text-zinc-500">{p.org ?? "—"}</td>
            <td className="py-2 text-right tabular-nums">{p.careerNhlGp}</td>
            {p.points !== null && (
              <>
                <td className="py-2 text-right tabular-nums">{p.gamesIngested}</td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {p.points.toFixed(1)}
                </td>
              </>
            )}
            {rosterContext && (
              <td className="py-2 text-right">
                {ownership.has(p.id) ? (
                  <span className="text-xs text-zinc-500">
                    {ownership.get(p.id)}
                  </span>
                ) : rosterContext.isMyTeam ? (
                  <form
                    action={addPlayerAction.bind(
                      null,
                      rosterContext.leagueId,
                      rosterContext.teamId,
                      p.id,
                    )}
                  >
                    <button type="submit" className="text-xs underline">
                      Add
                    </button>
                  </form>
                ) : (
                  <span className="text-xs text-zinc-500">—</span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
