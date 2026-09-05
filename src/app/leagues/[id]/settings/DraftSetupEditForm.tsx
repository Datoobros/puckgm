"use client";

import { useState } from "react";
import { updateDraftSetupAction, cancelDraftSetupAction } from "../draft/actions";

export function DraftSetupEditForm({
  leagueId,
  draftId,
  teams,
  currentRoundCount,
  currentPickTimerSeconds,
}: {
  leagueId: string;
  draftId: string;
  teams: { id: string; name: string }[];
  currentRoundCount: number;
  currentPickTimerSeconds: number;
}) {
  const [orderMode, setOrderMode] = useState<"" | "RANDOM" | "MANUAL">("");
  const [manualOrder, setManualOrder] = useState<string[]>(teams.map((t) => t.id));

  const inputClass = "mt-1 block w-full rounded border border-border bg-white px-2 py-1.5 text-sm text-black";

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <p className="text-xs text-muted">Editable until this draft starts — a pick made or a pick that&apos;s ever been traded locks it.</p>
      <form action={updateDraftSetupAction.bind(null, leagueId, draftId)} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted">Rounds</span>
            <input name="roundCount" type="number" min={1} defaultValue={currentRoundCount} className={inputClass} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Pick timer (seconds)</span>
            <input name="pickTimerSeconds" type="number" min={10} defaultValue={currentPickTimerSeconds} className={inputClass} />
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-muted">Round-1 order</span>
          <select
            name="orderMode"
            value={orderMode}
            onChange={(e) => setOrderMode(e.target.value as "" | "RANDOM" | "MANUAL")}
            className={inputClass}
          >
            <option value="">Keep current order</option>
            <option value="RANDOM">Re-shuffle randomly</option>
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

        <div className="flex gap-2">
          <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
            Save Draft Changes
          </button>
        </div>
      </form>
      <form
        action={cancelDraftSetupAction.bind(null, leagueId, draftId)}
        onSubmit={(e) => {
          if (!confirm("Cancel this draft setup entirely? This deletes every pick that hasn't been traded — refused if any has been.")) {
            e.preventDefault();
          }
        }}
      >
        <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-xs text-red-500 hover:bg-surface-tint">
          Cancel this draft
        </button>
      </form>
    </div>
  );
}
