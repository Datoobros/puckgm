import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isLeagueCommissioner, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getTradesForLeague, type TradeDetail } from "@/lib/trades/mutations";
import { isTradeParticipant, canVetoTrade, canForceProcessTrade } from "@/lib/trades/permissions";
import { Card, SectionLabel } from "@/components/Card";
import { Button, LinkButton } from "@/components/Button";
import { cancelTradeAction, castVetoAction, forceProcessTradeAction } from "./actions";

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

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;
  const isCommissioner = await isLeagueCommissioner(leagueId, userId);

  const trades = await getTradesForLeague(leagueId, myTeam?.id ?? null);

  const needsResponse = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.counterpartyTeamId === myTeam.id) : [];
  const myOpenProposals = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.proposedByTeamId === myTeam.id) : [];
  const pending = trades.filter((t) => t.state === "UNDER_REVIEW");

  const vetoCtx = { tradeVetoMode: settings.tradeVetoMode, isCommissioner, myTeamId: myTeam?.id ?? null };
  const canVeto = (t: TradeDetail) => canVetoTrade(t, vetoCtx);
  const canForceProcess = (t: TradeDetail) => canForceProcessTrade(t, { isCommissioner, myTeamId: myTeam?.id ?? null });

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
          <p className="mt-1 text-sm text-muted">
            Propose a trade — the other manager has to accept before anything moves. An accepted trade
            sits in a 24-hour review window ({settings.tradeVetoMode === "COMMISSIONER" ? "commissioner veto" : "league vote veto"}).
            {settings.tradeDeadline && ` New trades can't be proposed after ${settings.tradeDeadline}.`}
          </p>
        </div>
        {myTeam && (
          <LinkButton href={`/leagues/${leagueId}/trades/new`} variant="primary" className="shrink-0">
            Propose Trade
          </LinkButton>
        )}
      </div>

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
    </div>
  );
}
