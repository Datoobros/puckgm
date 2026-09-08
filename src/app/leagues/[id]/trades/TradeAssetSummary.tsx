// Shared, directive-less presentational pieces — imported directly by both
// a Server Component (the accept-review page) and a Client Component
// (TradeBuilder's own review step), so no "use client"/"use server" here.
// Full player stats reuse the same column config as the Players page and
// the team roster page (src/lib/players/columns.ts) rather than a new set.

import type { ReactNode } from "react";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS } from "@/lib/players/columns";
import type { PlayerStatsRow } from "@/lib/players/rankings";

export interface TradeAssetSummaryPlayer {
  id: string;
  fullName: string;
  headshotUrl: string | null;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
}

export interface TradeAssetSummarySide {
  teamName: string;
  players: TradeAssetSummaryPlayer[];
  picks: string[]; // pre-labeled, e.g. "2027 Round 2"
  faabAmount: number;
}

export function PlayerStatLine({
  player,
  stats,
  control,
}: {
  player: TradeAssetSummaryPlayer;
  stats: PlayerStatsRow | undefined;
  control?: ReactNode;
}) {
  const columns = player.primaryPosition === "G" ? [...GOALIE_COLUMNS, ...POINTS_COLUMNS] : [...SKATER_COLUMNS, ...POINTS_COLUMNS];
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
      {control}
      <PlayerHeadshot url={player.headshotUrl} alt={player.fullName} size={24} />
      <span>
        {player.fullName}
        <span className="ml-1 text-xs text-muted">
          {player.primaryPosition ?? "—"} · {player.currentNhlOrg ?? "—"}
        </span>
      </span>
      <span className="ml-auto flex flex-wrap gap-x-2 text-xs tabular-nums text-muted">
        {columns.map((col) => (
          <span key={col.key} title={col.label}>
            {stats ? (col.format ? col.format(col.get(stats)) : col.get(stats)) : "—"}
            <span className="ml-0.5 text-[10px] uppercase">{col.label}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

export function TradeAssetSummary({
  side,
  statsById,
}: {
  side: TradeAssetSummarySide;
  statsById: Record<string, PlayerStatsRow>;
}) {
  const hasAnything = side.players.length > 0 || side.picks.length > 0 || side.faabAmount > 0;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{side.teamName} sends</p>
      {!hasAnything && <p className="text-xs text-muted">Nothing.</p>}
      <div className="divide-y divide-border">
        {side.players.map((p) => (
          <PlayerStatLine key={p.id} player={p} stats={statsById[p.id]} />
        ))}
      </div>
      {side.picks.map((label) => (
        <p key={label} className="py-1.5 text-sm">
          {label}
        </p>
      ))}
      {side.faabAmount > 0 && <p className="py-1.5 text-sm">${side.faabAmount} FAAB</p>}
    </div>
  );
}
