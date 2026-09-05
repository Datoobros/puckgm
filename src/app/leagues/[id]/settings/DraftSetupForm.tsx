"use client";

import { useState } from "react";
import { setUpDraftAction } from "../draft/actions";

export function DraftSetupForm({
  leagueId,
  teams,
  defaultSeason,
}: {
  leagueId: string;
  teams: { id: string; name: string }[];
  defaultSeason: number;
}) {
  const [type, setType] = useState<"STARTUP" | "ROOKIE">("STARTUP");
  const [orderMode, setOrderMode] = useState<"RANDOM" | "MANUAL">("RANDOM");
  const [manualOrder, setManualOrder] = useState<string[]>(teams.map((t) => t.id));

  const inputClass = "mt-1 block w-full rounded border border-border bg-white px-2 py-1.5 text-sm text-black";

  return (
    <form action={setUpDraftAction.bind(null, leagueId)} className="space-y-3">
      <label className="block">
        <span className="text-xs text-muted">Draft type</span>
        <select name="type" value={type} onChange={(e) => setType(e.target.value as "STARTUP" | "ROOKIE")} className={inputClass}>
          <option value="STARTUP">Startup — draft the full NHL player pool</option>
          <option value="ROOKIE">Rookie — that year&apos;s NHL Entry Draft class</option>
        </select>
      </label>

      {type === "ROOKIE" && (
        <p className="text-xs text-muted">
          Requires that year&apos;s real draft class already ingested (an admin runs the ingestion
          script once, after the real NHL draft each June) — this will fail with an honest error if
          it hasn&apos;t been.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-muted">Season</span>
          <input name="season" type="number" defaultValue={defaultSeason} className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Rounds</span>
          <input name="roundCount" type="number" min={1} defaultValue={type === "STARTUP" ? 20 : 1} className={inputClass} />
        </label>
      </div>

      <label className="block max-w-xs">
        <span className="text-xs text-muted">Pick timer (seconds)</span>
        <input name="pickTimerSeconds" type="number" min={10} defaultValue={90} className={inputClass} />
      </label>

      <label className="block">
        <span className="text-xs text-muted">Round-1 order</span>
        <select
          name="orderMode"
          value={orderMode}
          onChange={(e) => setOrderMode(e.target.value as "RANDOM" | "MANUAL")}
          className={inputClass}
        >
          <option value="RANDOM">Random shuffle</option>
          <option value="MANUAL">Set manually</option>
        </select>
      </label>

      {orderMode === "MANUAL" && (
        <div className="space-y-2">
          {manualOrder.map((teamId, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-xs text-muted">{i + 1}.</span>
              <select
                name="manualOrder"
                value={teamId}
                onChange={(e) => {
                  const next = [...manualOrder];
                  next[i] = e.target.value;
                  setManualOrder(next);
                }}
                className={inputClass}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
        Set Up Draft
      </button>
    </form>
  );
}
