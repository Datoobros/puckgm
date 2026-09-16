import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, isTeamManager, isLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { activeRosterCap } from "@/lib/rosters/mutations";
import { getLeagueOwnershipMap } from "@/lib/rosters/ownership";
import { getFreeAgencyStatus, getCurrentDraft } from "@/lib/draft/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { getAvailableBudget, getMyPendingBids } from "@/lib/faab/mutations";
import { getWatchlistedPlayerIds } from "@/lib/players/watchlist";
import { STAT_RANGES, resolveStatRange } from "@/lib/players/seasons";
import { Card } from "@/components/Card";
import { LinkButton } from "@/components/Button";
import { PlayerStatsTable } from "./PlayerStatsTable";
import { PlayerSearchBox } from "./PlayerSearchBox";
import { StatRangeSelect } from "./StatRangeSelect";
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
  const rawRange = typeof params.range === "string" ? params.range : "";
  const range = STAT_RANGES.some((s) => s.value === rawRange) ? rawRange : "2025";
  const statRange = resolveStatRange(range) ?? resolveStatRange("2025")!;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, userId));

  // Free agency locked until the draft (issue #5) — see
  // src/lib/draft/mutations.ts's getFreeAgencyStatus for the full rule.
  // currentDraft is only used here to distinguish "a draft is set up but
  // hasn't started" from "no draft exists at all," for the banner copy.
  const [freeAgencyStatus, currentDraft, isCommissioner] = await Promise.all([
    getFreeAgencyStatus(leagueId),
    getCurrentDraft(leagueId),
    isLeagueCommissioner(leagueId, userId),
  ]);
  const freeAgencyOpen = freeAgencyStatus.open;

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
      dateRange: statRange,
    });
  } else {
    rows = await getPlayerStatsAggregate({
      limit: DEFAULT_POOL_SIZE,
      scoringConfig: settings.scoringConfig,
      dateRange: statRange,
    });
  }

  const ownershipMap = await getLeagueOwnershipMap(leagueId, rows.map((r) => r.id));
  const ownership = Object.fromEntries(ownershipMap);

  const [availableFaab, myPendingBids, myActiveRosterSlots, watchlistedIds] = await Promise.all([
    myTeam && settings.faabEnabled ? getAvailableBudget(myTeam.id, league.currentSeason, settings.faabBudget) : Promise.resolve(null),
    myTeam && settings.faabEnabled ? getMyPendingBids(leagueId, myTeam.id) : Promise.resolve([]),
    myTeam
      ? prisma.rosterSlot.findMany({
          where: { teamId: myTeam.id, slotType: "ACTIVE", effectiveTo: null },
          include: { player: { select: { id: true, fullName: true } } },
        })
      : Promise.resolve([]),
    getWatchlistedPlayerIds(leagueId, userId),
  ]);

  const rosterContext = myTeam
    ? {
        leagueId,
        teamId: myTeam.id,
        isMyTeam: true,
        activeCount: myActiveRosterSlots.length,
        activeCap: activeRosterCap(settings),
        activeRosterPlayers: myActiveRosterSlots.map((s) => ({ id: s.player.id, fullName: s.player.fullName })),
      }
    : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
      <p className="mt-1 text-sm text-muted">
        {league.name}&apos;s scoring, {statRange.label}.
        {!query && ` Showing top ${DEFAULT_POOL_SIZE} by points — search finds anyone.`}
      </p>
      {!myTeam && (
        <p className="mt-2 text-sm text-muted">
          You don&apos;t have a team in this league — viewing ownership only.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <PlayerSearchBox initialQuery={query} range={range} />
        <StatRangeSelect range={range} />
      </div>

      {!freeAgencyStatus.open && (
        <Card className="mt-4">
          {freeAgencyStatus.reason === "DRAFT_IN_PROGRESS" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Free agency is paused while the draft is running.</p>
              <LinkButton href={`/leagues/${leagueId}/draft`} variant="secondary" size="sm">
                Go to the draft room
              </LinkButton>
            </div>
          ) : currentDraft && currentDraft.status === "SETUP" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Free agency opens once the draft is complete.</p>
              <LinkButton href={`/leagues/${leagueId}/draft`} variant="secondary" size="sm">
                Go to the draft room
              </LinkButton>
            </div>
          ) : isCommissioner ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Set up the draft in League Settings to open free agency.</p>
              <LinkButton href={`/leagues/${leagueId}/settings`} variant="secondary" size="sm">
                Go to League Settings
              </LinkButton>
            </div>
          ) : (
            <p className="text-sm">Your commissioner hasn&apos;t set up the draft yet.</p>
          )}
        </Card>
      )}

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
          leagueId={leagueId}
          freeAgencyOpen={freeAgencyOpen}
          watchlistedIds={[...watchlistedIds]}
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
