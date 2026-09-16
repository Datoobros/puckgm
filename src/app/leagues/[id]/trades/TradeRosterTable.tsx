"use client";

// One team's tradeable-asset checklist for the ESPN-style builder
// (plans/trades-batch.md Task 2) — two stat tables (Skaters/Goalies, same
// column sets the team roster page uses) plus a compact picks/FAAB row
// below. Used for both "their roster" and "your roster" in TradeBuilder.tsx.
// A row whose player is locked in another pending trade or sitting on
// waivers (TradeableAssets.players[].lockedInTradeId/onWaiversUntil — see
// src/lib/trades/mutations.ts) can't be selected; the checkbox is disabled
// and a badge explains why, rather than letting the user pick an asset
// proposeTrade would just reject.

import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { Badge } from "@/components/Button";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import type { TradeableAssets, TradeAssetSelection } from "@/lib/trades/mutations";
import type { PlayerStatsRow } from "@/lib/players/rankings";

const TIER_BADGE: Record<string, string> = { FARM: "Farm", IR: "IR" };

function PositionTable({
  players,
  columns,
  statsById,
  selectedPlayerIds,
  onTogglePlayer,
}: {
  players: TradeableAssets["players"];
  columns: StatColumn[];
  statsById: Record<string, PlayerStatsRow>;
  selectedPlayerIds: string[];
  onTogglePlayer: (id: string) => void;
}) {
  if (players.length === 0) {
    return <p className="text-xs text-muted">None.</p>;
  }
  const allColumns = [...columns, ...POINTS_COLUMNS];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="w-8 py-2 pl-2" />
            <th className="py-2 pr-2 font-medium">Player</th>
            {allColumns.map((col) => (
              <th key={col.key} className="py-2 pr-2 text-right font-medium">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => {
            const stats = statsById[p.id];
            const disabled = !!p.lockedInTradeId || !!p.onWaiversUntil;
            const reason = p.lockedInTradeId
              ? "Locked in a pending trade — it must process or be cancelled first."
              : p.onWaiversUntil
                ? `On waivers until ${p.onWaiversUntil.toLocaleString()} — can't be traded until it clears.`
                : undefined;
            return (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="py-2 pl-2 align-top">
                  <input
                    type="checkbox"
                    checked={selectedPlayerIds.includes(p.id)}
                    disabled={disabled}
                    onChange={() => onTogglePlayer(p.id)}
                    title={reason}
                  />
                </td>
                <td className="py-2 pr-2 font-medium">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={28} />
                    {p.fullName}
                    <span className="text-xs text-muted">
                      {p.currentNhlOrg ?? "—"} · {p.primaryPosition ?? "—"}
                    </span>
                    {TIER_BADGE[p.slotType] && <Badge tone="muted">{TIER_BADGE[p.slotType]}</Badge>}
                    {disabled && (
                      <Badge tone="warning" title={reason}>
                        {p.lockedInTradeId ? "Pending trade" : "On waivers"}
                      </Badge>
                    )}
                  </span>
                </td>
                {allColumns.map((col) => (
                  <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                    {stats ? (col.format ? col.format(col.get(stats)) : col.get(stats)) : "—"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TradeRosterTable({
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
  const skaters = assets.players.filter((p) => p.primaryPosition !== "G");
  const goalies = assets.players.filter((p) => p.primaryPosition === "G");

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Skaters</p>
        <PositionTable
          players={skaters}
          columns={SKATER_COLUMNS}
          statsById={statsById}
          selectedPlayerIds={selected.playerIds}
          onTogglePlayer={onTogglePlayer}
        />
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Goalies</p>
        <PositionTable
          players={goalies}
          columns={GOALIE_COLUMNS}
          statsById={statsById}
          selectedPlayerIds={selected.playerIds}
          onTogglePlayer={onTogglePlayer}
        />
      </div>
      {(assets.picks.length > 0 || assets.availableFaab > 0) && (
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
          {assets.picks.map((pk) => (
            <label key={pk.id} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={selected.pickIds.includes(pk.id)}
                disabled={!!pk.lockedInTradeId}
                onChange={() => onTogglePick(pk.id)}
                title={pk.lockedInTradeId ? "Locked in a pending trade." : undefined}
              />
              {pk.season} Round {pk.round}
              {pk.lockedInTradeId && (
                <Badge tone="warning" title="Locked in a pending trade.">
                  Pending trade
                </Badge>
              )}
            </label>
          ))}
          {assets.availableFaab > 0 && (
            <label className="flex items-center gap-1.5 text-xs">
              FAAB
              <input
                type="number"
                min={0}
                max={assets.availableFaab}
                value={selected.faabAmount}
                onChange={(e) => onFaabChange(Math.max(0, Math.min(assets.availableFaab, Number(e.target.value) || 0)))}
                className="w-16 rounded border border-border bg-surface px-1.5 py-1 text-xs text-foreground"
              />
              <span className="text-muted">(${assets.availableFaab} available)</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
