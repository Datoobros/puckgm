import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isLeagueCommissioner, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import {
  getTradesForLeague,
  getTradeableAssets,
  getTradeDetailById,
  type TradeDetail,
  type TradeItemDetail,
  type TradeAssetSelection,
} from "@/lib/trades/mutations";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { Card, SectionLabel } from "@/components/Card";
import { Button, LinkButton, Badge } from "@/components/Button";
import { TradeBuilder } from "./TradeBuilder";
import { cancelTradeAction, castVetoAction, forceProcessTradeAction } from "./actions";

function selectionFromItems(items: TradeItemDetail[]): TradeAssetSelection {
  return {
    playerIds: items.filter((i) => i.itemType === "PLAYER" && i.playerId).map((i) => i.playerId!),
    pickIds: items.filter((i) => i.itemType === "PICK" && i.pickId).map((i) => i.pickId!),
    faabAmount: items.find((i) => i.itemType === "FAAB")?.faabAmount ?? 0,
  };
}

function itemLabel(item: TradeDetail["items"][number]): string {
  if (item.itemType === "PLAYER") return item.playerName ?? "a player";
  if (item.itemType === "PICK") return item.pickLabel ?? "a pick";
  return `$${item.faabAmount} FAAB`;
}

function TradeSummary({ trade }: { trade: TradeDetail }) {
  const gives = trade.items.filter((i) => i.fromTeamId === trade.proposedByTeamId);
  const gets = trade.items.filter((i) => i.toTeamId === trade.proposedByTeamId);
  return (
    <p className="text-sm">
      <span className="font-medium">{trade.proposedByTeamName}</span> gives{" "}
      {gives.map(itemLabel).join(", ") || "nothing"} →{" "}
      <span className="font-medium">{trade.counterpartyTeamName}</span> gives{" "}
      {gets.map(itemLabel).join(", ") || "nothing"}
    </p>
  );
}

function timeLeft(reviewEndsAt: Date | null): string {
  if (!reviewEndsAt) return "";
  const ms = reviewEndsAt.getTime() - Date.now();
  if (ms <= 0) return "processing soon";
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours <= 1 ? "< 1 hour left" : `${hours} hours left`;
}

export default async function TradesPage(props: PageProps<"/leagues/[id]/trades">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const counterFrom = Array.isArray(sp.counterFrom) ? sp.counterFrom[0] : sp.counterFrom;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;
  const isCommissioner = await isLeagueCommissioner(leagueId, userId);

  const trades = await getTradesForLeague(leagueId, myTeam?.id ?? null);

  // Counter-offer prefill — only trust a counterFrom trade the current team
  // actually was the counterparty on (never trust the query param alone).
  // What the original proposer gave becomes what's now offered to receive,
  // and vice versa; fully editable from here, no data-model link retained.
  let counterSeed: { counterpartyId: string; give: TradeAssetSelection; receive: TradeAssetSelection } | null = null;
  if (counterFrom && myTeam) {
    const original = await getTradeDetailById(counterFrom, myTeam.id);
    if (original && original.counterpartyTeamId === myTeam.id) {
      const proposerGave = original.items.filter((i) => i.fromTeamId === original.proposedByTeamId);
      const counterpartyGave = original.items.filter((i) => i.fromTeamId === original.counterpartyTeamId);
      counterSeed = {
        counterpartyId: original.proposedByTeamId,
        give: selectionFromItems(counterpartyGave),
        receive: selectionFromItems(proposerGave),
      };
    }
  }

  const isParticipant = (t: TradeDetail) => !!myTeam && (t.proposedByTeamId === myTeam.id || t.counterpartyTeamId === myTeam.id);
  const needsResponse = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.counterpartyTeamId === myTeam.id) : [];
  const myOpenProposals = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.proposedByTeamId === myTeam.id) : [];
  const pending = trades.filter((t) => t.state === "UNDER_REVIEW");
  const history = trades.filter((t) => ["PROCESSED", "VETOED", "DECLINED", "CANCELLED"].includes(t.state)).slice(0, 20);

  function canVeto(t: TradeDetail): boolean {
    if (t.state !== "UNDER_REVIEW") return false;
    // A commissioner who's a party to this specific trade can't decide it,
    // same conflict-of-interest exclusion VOTE mode already applies.
    if (settings.tradeVetoMode === "COMMISSIONER") return isCommissioner && !isParticipant(t);
    return !!myTeam && !isParticipant(t) && !t.hasVetoed;
  }
  function canForceProcess(t: TradeDetail): boolean {
    return isCommissioner && !isParticipant(t);
  }

  let builderSection = null;
  if (myTeam) {
    const otherTeams = league.teams.filter((t) => t.id !== myTeam.id);
    const [myAssets, ...otherAssets] = await Promise.all([
      getTradeableAssets(myTeam.id),
      ...otherTeams.map((t) => getTradeableAssets(t.id)),
    ]);

    const allPlayerIds = [myAssets, ...otherAssets].flatMap((a) => a.players.map((p) => p.id));
    const statsRows = allPlayerIds.length > 0
      ? await getPlayerStatsAggregate({ playerIds: allPlayerIds, scoringConfig: settings.scoringConfig })
      : [];
    const statsById: Record<string, PlayerStatsRow> = Object.fromEntries(statsRows.map((r) => [r.id, r]));

    builderSection = (
      <TradeBuilder
        leagueId={leagueId}
        myTeamId={myTeam.id}
        myAssets={myAssets}
        otherTeams={otherTeams.map((t, i) => ({ teamId: t.id, teamName: t.name, assets: otherAssets[i] }))}
        statsById={statsById}
        initialCounterpartyId={counterSeed?.counterpartyId}
        initialGive={counterSeed?.give}
        initialReceive={counterSeed?.receive}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
      <p className="mt-1 text-sm text-muted">
        Propose a trade — the other manager has to accept before anything moves. An accepted trade
        sits in a 24-hour review window ({settings.tradeVetoMode === "COMMISSIONER" ? "commissioner veto" : "league vote veto"}).
        {settings.tradeDeadline && ` New trades can't be proposed after ${settings.tradeDeadline}.`}
      </p>

      {myTeam && (
        <div className="mt-6">
          <SectionLabel>Propose a trade</SectionLabel>
          <Card>{builderSection}</Card>
        </div>
      )}

      {needsResponse.length > 0 && (
        <div className="mt-6">
          <SectionLabel>Needs your response</SectionLabel>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {needsResponse.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <LinkButton href={`/leagues/${leagueId}/trades/${t.id}/review`} variant="primary" size="sm" className="shrink-0">
                    Review
                  </LinkButton>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {myOpenProposals.length > 0 && (
        <div className="mt-6">
          <SectionLabel>Waiting on a response</SectionLabel>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {myOpenProposals.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <form action={cancelTradeAction.bind(null, leagueId, t.id)}>
                    <Button type="submit" size="sm" className="shrink-0">Withdraw</Button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div className="mt-6">
        <SectionLabel>Pending (under review)</SectionLabel>
        {pending.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No trades currently under review.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {pending.map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <TradeSummary trade={t} />
                    <span className="shrink-0 text-xs text-muted">{timeLeft(t.reviewEndsAt)}</span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    {canVeto(t) && (
                      <form action={castVetoAction.bind(null, leagueId, t.id)}>
                        <Button type="submit" variant="danger" size="sm">Veto</Button>
                      </form>
                    )}
                    {canForceProcess(t) && (
                      <form action={forceProcessTradeAction.bind(null, leagueId, t.id)}>
                        <Button type="submit" size="sm">Force through now</Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="mt-6">
        <SectionLabel>History</SectionLabel>
        {history.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No resolved trades yet.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {history.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <Badge tone="muted" className="shrink-0">{t.state}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
