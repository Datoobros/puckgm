import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager } from "@/lib/leagues/mutations";
import { getTradeDetailById } from "@/lib/trades/mutations";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { TradeAssetSummary, type TradeAssetSummarySide } from "../../TradeAssetSummary";
import { respondToTradeAction, counterTradeAction } from "../../actions";

export default async function TradeReviewPage(props: PageProps<"/leagues/[id]/trades/[tradeId]/review">) {
  const { userId } = await auth.protect();
  const { id: leagueId, tradeId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;

  const trade = await getTradeDetailById(tradeId, myTeam?.id ?? null);
  if (!trade) notFound();

  const isCounterparty = !!myTeam && myTeam.id === trade.counterpartyTeamId;
  const canAct = isCounterparty && trade.state === "PROPOSED";

  const playerIds = trade.items.filter((i) => i.itemType === "PLAYER" && i.playerId).map((i) => i.playerId!);
  const statsRows = playerIds.length > 0 ? await getPlayerStatsAggregate({ playerIds }) : [];
  const statsById: Record<string, PlayerStatsRow> = Object.fromEntries(statsRows.map((r) => [r.id, r]));
  const statsByIdFull = new Map(statsRows.map((r) => [r.id, r]));

  function sideFor(teamId: string, teamName: string): TradeAssetSummarySide {
    const items = trade!.items.filter((i) => i.fromTeamId === teamId);
    return {
      teamName,
      players: items
        .filter((i) => i.itemType === "PLAYER" && i.playerId)
        .map((i) => statsByIdFull.get(i.playerId!))
        .filter((p): p is PlayerStatsRow => !!p),
      picks: items.filter((i) => i.itemType === "PICK" && i.pickLabel).map((i) => i.pickLabel!),
      faabAmount: items.find((i) => i.itemType === "FAAB")?.faabAmount ?? 0,
    };
  }

  const proposerSide = sideFor(trade.proposedByTeamId, trade.proposedByTeamName);
  const counterpartySide = sideFor(trade.counterpartyTeamId, trade.counterpartyTeamName);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/trades`} className="text-sm text-muted hover:underline">
        ← Trades
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Review trade</h1>
      <p className="mt-1 text-sm text-muted">
        {trade.proposedByTeamName} proposed this trade with {trade.counterpartyTeamName}.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <TradeAssetSummary side={proposerSide} statsById={statsById} />
        </Card>
        <Card>
          <TradeAssetSummary side={counterpartySide} statsById={statsById} />
        </Card>
      </div>

      {canAct ? (
        <div className="mt-6 flex flex-wrap gap-2">
          <form action={respondToTradeAction.bind(null, leagueId, trade.id, true)}>
            <Button type="submit" variant="primary">Accept</Button>
          </form>
          <form action={respondToTradeAction.bind(null, leagueId, trade.id, false)}>
            <Button type="submit">Decline</Button>
          </form>
          <form action={counterTradeAction.bind(null, leagueId, trade.id)}>
            <Button type="submit">Counter</Button>
          </form>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">
          {trade.state !== "PROPOSED"
            ? "This trade is no longer awaiting a response."
            : "Only the team this trade was sent to can respond."}
        </p>
      )}
    </div>
  );
}
