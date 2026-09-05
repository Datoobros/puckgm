"use client";

import { useState } from "react";
import { Card } from "@/components/Card";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { proposeTradeAction } from "./actions";
import type { TradeableAssets } from "@/lib/trades/mutations";

function AssetChecklist({ prefix, assets }: { prefix: "give" | "receive"; assets: TradeableAssets }) {
  return (
    <div className="space-y-2">
      {assets.players.length === 0 && assets.picks.length === 0 && (
        <p className="text-xs text-muted">No players or picks to offer.</p>
      )}
      {assets.players.map((p) => (
        <label key={p.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={`${prefix}PlayerIds`} value={p.id} />
          <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={24} />
          {p.fullName}
          <span className="text-xs text-muted">
            {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"} · {p.slotType}
          </span>
        </label>
      ))}
      {assets.picks.map((pk) => (
        <label key={pk.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={`${prefix}PickIds`} value={pk.id} />
          {pk.season} Round {pk.round}
        </label>
      ))}
      <label className="flex items-center gap-2 pt-1 text-sm">
        FAAB
        <input
          type="number"
          name={`${prefix}Faab`}
          min={0}
          max={assets.availableFaab}
          defaultValue={0}
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
}: {
  leagueId: string;
  myTeamId: string;
  myAssets: TradeableAssets;
  otherTeams: { teamId: string; teamName: string; assets: TradeableAssets }[];
}) {
  const [counterpartyId, setCounterpartyId] = useState(otherTeams[0]?.teamId ?? "");
  const counterparty = otherTeams.find((t) => t.teamId === counterpartyId);

  if (otherTeams.length === 0) {
    return <p className="text-sm text-muted">No other teams in this league to trade with.</p>;
  }

  return (
    <form action={proposeTradeAction.bind(null, leagueId, myTeamId)} className="space-y-4">
      <label className="block text-sm">
        <span className="text-xs text-muted">Trade with</span>
        <select
          name="counterpartyTeamId"
          value={counterpartyId}
          onChange={(e) => setCounterpartyId(e.target.value)}
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
          <AssetChecklist prefix="give" assets={myAssets} />
        </Card>
        <Card>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You get</p>
          {counterparty && <AssetChecklist prefix="receive" assets={counterparty.assets} />}
        </Card>
      </div>

      <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground">
        Propose Trade
      </button>
    </form>
  );
}
