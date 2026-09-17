import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getTradesForLeague, type TradeDetail } from "@/lib/trades/mutations";
import { canVetoTrade, canForceProcessTrade } from "@/lib/trades/permissions";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { Card, SectionLabel } from "@/components/Card";
import { Button, Badge, type BadgeTone } from "@/components/Button";
import { TradeAssetSummary, type TradeAssetSummarySide } from "@/app/leagues/[id]/trades/TradeAssetSummary";
import { castVetoAction, forceProcessTradeAction, cancelTradeAction } from "@/app/leagues/[id]/trades/actions";

const STATE_LABEL: Record<string, string> = {
  PROPOSED: "Proposed",
  UNDER_REVIEW: "Under review",
  VETOED: "Vetoed",
  PROCESSED: "Processed",
  CANCELLED: "Cancelled",
  DECLINED: "Declined",
};
const STATE_TONE: Record<string, BadgeTone> = {
  PROPOSED: "muted",
  UNDER_REVIEW: "navy",
  VETOED: "danger",
  PROCESSED: "success",
  CANCELLED: "muted",
  DECLINED: "muted",
};

function itemLabel(item: TradeDetail["items"][number]): string {
  if (item.itemType === "PLAYER") return item.playerName ?? "a player";
  if (item.itemType === "PICK") return item.pickLabel ?? "a pick";
  return `$${item.faabAmount} FAAB`;
}

function tradeOneLiner(t: TradeDetail): string {
  const gives = t.items.filter((i) => i.fromTeamId === t.proposedByTeamId).map(itemLabel).join(", ") || "nothing";
  const gets = t.items.filter((i) => i.toTeamId === t.proposedByTeamId).map(itemLabel).join(", ") || "nothing";
  return `${t.proposedByTeamName} gives ${gives} → ${t.counterpartyTeamName} gives ${gets}`;
}

export default async function TradeReviewPage(props: PageProps<"/leagues/[id]/settings/trade-review">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;

  const allTrades = await getTradesForLeague(leagueId, myTeam?.id ?? null);
  const awaitingReview = allTrades.filter((t) => t.state === "PROPOSED" || t.state === "UNDER_REVIEW");
  const resolved = allTrades.filter((t) => t.state !== "PROPOSED" && t.state !== "UNDER_REVIEW").slice(0, 10);

  // Reached this page at all only via settings/layout.tsx's commissioner
  // gate, so the viewer is always a commissioner here.
  const vetoCtx = { tradeVetoMode: settings.tradeVetoMode, isCommissioner: true, myTeamId: myTeam?.id ?? null };

  const playerIds = awaitingReview.flatMap((t) =>
    t.items.filter((i) => i.itemType === "PLAYER" && i.playerId).map((i) => i.playerId!),
  );
  const statsRows = playerIds.length > 0 ? await getPlayerStatsAggregate({ playerIds }) : [];
  const statsById: Record<string, PlayerStatsRow> = Object.fromEntries(statsRows.map((r) => [r.id, r]));
  const statsByIdFull = new Map(statsRows.map((r) => [r.id, r]));

  function sideFor(t: TradeDetail, teamId: string, teamName: string): TradeAssetSummarySide {
    const items = t.items.filter((i) => i.fromTeamId === teamId);
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

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Trade Review</h1>
      <p className="mt-2 text-sm text-muted">
        Review, veto, or force through pending trades.
      </p>

      <div className="mt-8">
        <SectionLabel>Awaiting review</SectionLabel>
        {awaitingReview.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No trades awaiting review.</p>
          </Card>
        ) : (
          <div className="space-y-4">
            {awaitingReview.map((t) => {
              const veto = canVetoTrade(t, vetoCtx);
              const force = t.state === "UNDER_REVIEW" && canForceProcessTrade(t, vetoCtx);
              const cancel = t.state === "PROPOSED";
              return (
                <Card key={t.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {t.proposedByTeamName} ↔ {t.counterpartyTeamName}
                    </p>
                    <Badge tone={STATE_TONE[t.state]}>{STATE_LABEL[t.state] ?? t.state}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Proposed {t.proposedAt.toLocaleString()}
                    {t.reviewEndsAt && ` · review ends ${t.reviewEndsAt.toLocaleString()}`}
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <TradeAssetSummary side={sideFor(t, t.proposedByTeamId, t.proposedByTeamName)} statsById={statsById} />
                    <TradeAssetSummary side={sideFor(t, t.counterpartyTeamId, t.counterpartyTeamName)} statsById={statsById} />
                  </div>
                  {(veto || force || cancel) && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      {veto && (
                        <form action={castVetoAction.bind(null, leagueId, t.id)}>
                          <Button type="submit" variant="danger" size="sm">
                            Veto
                          </Button>
                        </form>
                      )}
                      {force && (
                        <form action={forceProcessTradeAction.bind(null, leagueId, t.id)}>
                          <Button type="submit" size="sm">
                            Force through now
                          </Button>
                        </form>
                      )}
                      {cancel && (
                        <form action={cancelTradeAction.bind(null, leagueId, t.id)}>
                          <Button type="submit" size="sm">
                            Cancel
                          </Button>
                        </form>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-8">
        <SectionLabel>Last 10 resolved trades</SectionLabel>
        {resolved.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No resolved trades yet.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {resolved.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <p className="text-sm">{tradeOneLiner(t)}</p>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {t.commissionerExecuted && <Badge tone="gold">LM trade</Badge>}
                    <Badge tone={STATE_TONE[t.state]}>{STATE_LABEL[t.state] ?? t.state}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
