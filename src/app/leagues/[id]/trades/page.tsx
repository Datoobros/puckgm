import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { getTradesForLeague, getTradeableAssets, type TradeDetail } from "@/lib/trades/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { TradeBuilder } from "./TradeBuilder";
import { respondToTradeAction, cancelTradeAction, castVetoAction, forceProcessTradeAction } from "./actions";

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
  const myTeam = league.teams.find((t) => t.managerUserId === userId) ?? null;
  const commissioner = await getLeagueCommissioner(leagueId);
  const isCommissioner = commissioner === userId;

  const trades = await getTradesForLeague(leagueId, myTeam?.id ?? null);

  const isParticipant = (t: TradeDetail) => !!myTeam && (t.proposedByTeamId === myTeam.id || t.counterpartyTeamId === myTeam.id);
  const needsResponse = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.counterpartyTeamId === myTeam.id) : [];
  const myOpenProposals = myTeam ? trades.filter((t) => t.state === "PROPOSED" && t.proposedByTeamId === myTeam.id) : [];
  const pending = trades.filter((t) => t.state === "UNDER_REVIEW");
  const history = trades.filter((t) => ["PROCESSED", "VETOED", "DECLINED", "CANCELLED"].includes(t.state)).slice(0, 20);

  function canVeto(t: TradeDetail): boolean {
    if (t.state !== "UNDER_REVIEW") return false;
    if (settings.tradeVetoMode === "COMMISSIONER") return isCommissioner;
    return !!myTeam && !isParticipant(t) && !t.hasVetoed;
  }
  function canCancel(t: TradeDetail): boolean {
    return (t.state === "PROPOSED" || t.state === "UNDER_REVIEW") && (isParticipant(t) || isCommissioner);
  }

  let builderSection = null;
  if (myTeam) {
    const otherTeams = league.teams.filter((t) => t.id !== myTeam.id);
    const [myAssets, ...otherAssets] = await Promise.all([
      getTradeableAssets(myTeam.id),
      ...otherTeams.map((t) => getTradeableAssets(t.id)),
    ]);
    builderSection = (
      <TradeBuilder
        leagueId={leagueId}
        myTeamId={myTeam.id}
        myAssets={myAssets}
        otherTeams={otherTeams.map((t, i) => ({ teamId: t.id, teamName: t.name, assets: otherAssets[i] }))}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
      <p className="mt-1 text-sm text-zinc-500">
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
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {needsResponse.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <span className="flex shrink-0 gap-2">
                    <form action={respondToTradeAction.bind(null, leagueId, t.id, true)}>
                      <button type="submit" className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                        Accept
                      </button>
                    </form>
                    <form action={respondToTradeAction.bind(null, leagueId, t.id, false)}>
                      <button type="submit" className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                        Decline
                      </button>
                    </form>
                  </span>
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
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {myOpenProposals.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <form action={cancelTradeAction.bind(null, leagueId, t.id)}>
                    <button type="submit" className="shrink-0 rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                      Withdraw
                    </button>
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
            <p className="text-sm text-zinc-500">No trades currently under review.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {pending.map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <TradeSummary trade={t} />
                    <span className="shrink-0 text-xs text-zinc-500">{timeLeft(t.reviewEndsAt)}</span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    {canCancel(t) && (
                      <form action={cancelTradeAction.bind(null, leagueId, t.id)}>
                        <button type="submit" className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                          Cancel
                        </button>
                      </form>
                    )}
                    {canVeto(t) && (
                      <form action={castVetoAction.bind(null, leagueId, t.id)}>
                        <button type="submit" className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                          Veto
                        </button>
                      </form>
                    )}
                    {isCommissioner && (
                      <form action={forceProcessTradeAction.bind(null, leagueId, t.id)}>
                        <button type="submit" className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]">
                          Force through now
                        </button>
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
            <p className="text-sm text-zinc-500">No resolved trades yet.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {history.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <TradeSummary trade={t} />
                  <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/10">
                    {t.state}
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
