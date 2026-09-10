"use client";

import { useState } from "react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { proposeTradeAction } from "./actions";
import { PlayerStatLine, TradeAssetSummary, type TradeAssetSummarySide } from "./TradeAssetSummary";
import type { TradeableAssets, TradeAssetSelection } from "@/lib/trades/mutations";
import type { PlayerStatsRow } from "@/lib/players/rankings";

const EMPTY_SELECTION: TradeAssetSelection = { playerIds: [], pickIds: [], faabAmount: 0 };

function totalItems(sel: TradeAssetSelection): number {
  return sel.playerIds.length + sel.pickIds.length + (sel.faabAmount > 0 ? 1 : 0);
}

function AssetChecklist({
  assets,
  statsById,
  selected,
  onTogglePlayer,
  onTogglePick,
  onFaabChange,
}: {
  assets: TradeableAssets;
  statsById: Record<string, PlayerStatsRow>;
  selected: TradeAssetSelection;
  onTogglePlayer: (id: string) => void;
  onTogglePick: (id: string) => void;
  onFaabChange: (amount: number) => void;
}) {
  return (
    <div className="divide-y divide-border">
      {assets.players.length === 0 && assets.picks.length === 0 && (
        <p className="text-xs text-muted">No players or picks to offer.</p>
      )}
      {assets.players.map((p) => (
        <PlayerStatLine
          key={p.id}
          player={p}
          stats={statsById[p.id]}
          control={
            <input
              type="checkbox"
              checked={selected.playerIds.includes(p.id)}
              onChange={() => onTogglePlayer(p.id)}
            />
          }
        />
      ))}
      {assets.picks.map((pk) => (
        <label key={pk.id} className="flex items-center gap-2 py-1.5 text-sm">
          <input type="checkbox" checked={selected.pickIds.includes(pk.id)} onChange={() => onTogglePick(pk.id)} />
          {pk.season} Round {pk.round}
        </label>
      ))}
      <label className="flex items-center gap-2 py-1.5 text-sm">
        FAAB
        <input
          type="number"
          min={0}
          max={assets.availableFaab}
          value={selected.faabAmount}
          onChange={(e) => onFaabChange(Math.max(0, Math.min(assets.availableFaab, Number(e.target.value) || 0)))}
          className="w-20 rounded border border-border bg-surface px-1.5 py-1 text-xs text-foreground"
        />
        <span className="text-xs text-muted">(${assets.availableFaab} available)</span>
      </label>
    </div>
  );
}

export function TradeBuilder({
  leagueId,
  myTeamId,
  myAssets,
  otherTeams,
  statsById,
  initialCounterpartyId,
  initialGive,
  initialReceive,
}: {
  leagueId: string;
  myTeamId: string;
  myAssets: TradeableAssets;
  otherTeams: { teamId: string; teamName: string; assets: TradeableAssets }[];
  statsById: Record<string, PlayerStatsRow>;
  initialCounterpartyId?: string;
  initialGive?: TradeAssetSelection;
  initialReceive?: TradeAssetSelection;
}) {
  const [step, setStep] = useState<"select" | "review">("select");
  const [counterpartyId, setCounterpartyId] = useState(initialCounterpartyId ?? otherTeams[0]?.teamId ?? "");
  const [give, setGive] = useState<TradeAssetSelection>(initialGive ?? EMPTY_SELECTION);
  const [receive, setReceive] = useState<TradeAssetSelection>(initialReceive ?? EMPTY_SELECTION);

  const counterparty = otherTeams.find((t) => t.teamId === counterpartyId);

  if (otherTeams.length === 0) {
    return <p className="text-sm text-muted">No other teams in this league to trade with.</p>;
  }

  function toggle(sel: TradeAssetSelection, setSel: (s: TradeAssetSelection) => void, key: "playerIds" | "pickIds", id: string) {
    const list = sel[key];
    setSel({ ...sel, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  }

  function selectionSide(teamName: string, assets: TradeableAssets, sel: TradeAssetSelection): TradeAssetSummarySide {
    return {
      teamName,
      players: assets.players.filter((p) => sel.playerIds.includes(p.id)),
      picks: assets.picks.filter((pk) => sel.pickIds.includes(pk.id)).map((pk) => `${pk.season} Round ${pk.round}`),
      faabAmount: sel.faabAmount,
    };
  }

  if (step === "review" && counterparty) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <TradeAssetSummary side={selectionSide("You", myAssets, give)} statsById={statsById} />
          </Card>
          <Card>
            <TradeAssetSummary side={selectionSide(counterparty.teamName, counterparty.assets, receive)} statsById={statsById} />
          </Card>
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={() => setStep("select")}>Back</Button>
          <form action={proposeTradeAction.bind(null, leagueId, myTeamId)}>
            <input type="hidden" name="counterpartyTeamId" value={counterpartyId} />
            {give.playerIds.map((id) => (
              <input key={id} type="hidden" name="givePlayerIds" value={id} />
            ))}
            {give.pickIds.map((id) => (
              <input key={id} type="hidden" name="givePickIds" value={id} />
            ))}
            <input type="hidden" name="giveFaab" value={give.faabAmount} />
            {receive.playerIds.map((id) => (
              <input key={id} type="hidden" name="receivePlayerIds" value={id} />
            ))}
            {receive.pickIds.map((id) => (
              <input key={id} type="hidden" name="receivePickIds" value={id} />
            ))}
            <input type="hidden" name="receiveFaab" value={receive.faabAmount} />
            <Button type="submit" variant="primary">Confirm & Send</Button>
          </form>
        </div>
      </div>
    );
  }

  const canReview = totalItems(give) + totalItems(receive) > 0 && !!counterparty;

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="text-xs text-muted">Trade with</span>
        <select
          value={counterpartyId}
          onChange={(e) => {
            setCounterpartyId(e.target.value);
            setReceive(EMPTY_SELECTION);
          }}
          className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        >
          {otherTeams.map((t) => (
            <option key={t.teamId} value={t.teamId}>
              {t.teamName}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You give</p>
          <AssetChecklist
            assets={myAssets}
            statsById={statsById}
            selected={give}
            onTogglePlayer={(id) => toggle(give, setGive, "playerIds", id)}
            onTogglePick={(id) => toggle(give, setGive, "pickIds", id)}
            onFaabChange={(amount) => setGive({ ...give, faabAmount: amount })}
          />
        </Card>
        <Card>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You get</p>
          {counterparty && (
            <AssetChecklist
              assets={counterparty.assets}
              statsById={statsById}
              selected={receive}
              onTogglePlayer={(id) => toggle(receive, setReceive, "playerIds", id)}
              onTogglePick={(id) => toggle(receive, setReceive, "pickIds", id)}
              onFaabChange={(amount) => setReceive({ ...receive, faabAmount: amount })}
            />
          )}
        </Card>
      </div>

      <Button type="button" variant="primary" disabled={!canReview} onClick={() => setStep("review")}>
        Review Trade
      </Button>
    </div>
  );
}
