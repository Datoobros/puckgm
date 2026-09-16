import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getTradeableAssets, getTradeDetailById, type TradeAssetSelection, type TradeItemDetail } from "@/lib/trades/mutations";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { TradeBuilder } from "../TradeBuilder";

function selectionFromItems(items: TradeItemDetail[]): TradeAssetSelection {
  return {
    playerIds: items.filter((i) => i.itemType === "PLAYER" && i.playerId).map((i) => i.playerId!),
    pickIds: items.filter((i) => i.itemType === "PICK" && i.pickId).map((i) => i.pickId!),
    faabAmount: items.find((i) => i.itemType === "FAAB")?.faabAmount ?? 0,
  };
}

function parseIdList(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function parseFaab(value: string | undefined, available: number): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(available, Math.floor(n)));
}

export default async function NewTradePage(props: PageProps<"/leagues/[id]/trades/new">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const first = (key: string): string | undefined => {
    const v = sp[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;
  if (!myTeam) redirect(`/leagues/${leagueId}/trades`);

  const otherTeams = league.teams.filter((t) => t.id !== myTeam.id);

  if (otherTeams.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Link href={`/leagues/${leagueId}/trades`} className="text-sm text-muted hover:underline">
          ← Trades
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Propose a trade</h1>
        <p className="mt-4 text-sm text-muted">No other teams in this league to trade with.</p>
      </div>
    );
  }

  const counterFrom = first("counterFrom");
  const withParam = first("with");

  let counterpartyId: string | null = null;
  let counterSeed: { give: TradeAssetSelection; receive: TradeAssetSelection } | null = null;

  // Counter-offer prefill — moved here verbatim from the old /trades page
  // (plans/trades-batch.md Task 2). Only trust a counterFrom trade the
  // current team actually was the counterparty on (never trust the query
  // param alone). What the original proposer gave becomes what's now
  // offered to receive, and vice versa; fully editable from here, no
  // data-model link retained.
  if (counterFrom) {
    const original = await getTradeDetailById(counterFrom, myTeam.id);
    if (original && original.counterpartyTeamId === myTeam.id) {
      counterpartyId = original.proposedByTeamId;
      const proposerGave = original.items.filter((i) => i.fromTeamId === original.proposedByTeamId);
      const counterpartyGave = original.items.filter((i) => i.fromTeamId === original.counterpartyTeamId);
      counterSeed = {
        give: selectionFromItems(counterpartyGave),
        receive: selectionFromItems(proposerGave),
      };
    }
  }

  if (!counterpartyId) {
    counterpartyId = withParam && otherTeams.some((t) => t.id === withParam) ? withParam : otherTeams[0].id;
  }

  const counterpartyTeam = otherTeams.find((t) => t.id === counterpartyId)!;

  const [myAssets, counterpartyAssets] = await Promise.all([
    getTradeableAssets(myTeam.id),
    getTradeableAssets(counterpartyTeam.id),
  ]);

  // Saved-selection restore (give/receive/givePicks/receivePicks/giveFaab/
  // receiveFaab) — Task 3's "Return to trade builder" flow encodes the
  // current selection into these params before navigating away to drop
  // mode; implemented here now so the builder has exactly one initial-state
  // path, even though nothing generates these params yet in this task.
  // Parsed against each team's actual tradeable assets — an id that isn't
  // currently owned/tradeable is dropped silently rather than erroring.
  let initialGive: TradeAssetSelection;
  let initialReceive: TradeAssetSelection;
  if (counterSeed) {
    initialGive = counterSeed.give;
    initialReceive = counterSeed.receive;
  } else {
    initialGive = {
      playerIds: parseIdList(first("give")).filter((id) => myAssets.players.some((p) => p.id === id)),
      pickIds: parseIdList(first("givePicks")).filter((id) => myAssets.picks.some((p) => p.id === id)),
      faabAmount: parseFaab(first("giveFaab"), myAssets.availableFaab),
    };
    initialReceive = {
      playerIds: parseIdList(first("receive")).filter((id) => counterpartyAssets.players.some((p) => p.id === id)),
      pickIds: parseIdList(first("receivePicks")).filter((id) => counterpartyAssets.picks.some((p) => p.id === id)),
      faabAmount: parseFaab(first("receiveFaab"), counterpartyAssets.availableFaab),
    };
  }

  const allPlayerIds = [...myAssets.players.map((p) => p.id), ...counterpartyAssets.players.map((p) => p.id)];
  const statsRows = allPlayerIds.length > 0
    ? await getPlayerStatsAggregate({ playerIds: allPlayerIds, scoringConfig: settings.scoringConfig })
    : [];
  const statsById: Record<string, PlayerStatsRow> = Object.fromEntries(statsRows.map((r) => [r.id, r]));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/trades`} className="text-sm text-muted hover:underline">
        ← Trades
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Propose a trade</h1>

      <TradeBuilder
        leagueId={leagueId}
        myTeamId={myTeam.id}
        myTeamName={myTeam.name}
        myAssets={myAssets}
        otherTeams={otherTeams.map((t) => ({ teamId: t.id, teamName: t.name }))}
        counterpartyId={counterpartyTeam.id}
        counterpartyName={counterpartyTeam.name}
        counterpartyAssets={counterpartyAssets}
        statsById={statsById}
        initialGive={initialGive}
        initialReceive={initialReceive}
      />
    </div>
  );
}
