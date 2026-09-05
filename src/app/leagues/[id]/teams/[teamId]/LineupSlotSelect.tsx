"use client";

import { setLineupSlotAction } from "./actions";

export interface SlotOption {
  value: string;
  label: string;
  disabled: boolean;
}

export function LineupSlotSelect({
  leagueId,
  teamId,
  playerId,
  date,
  value,
  options,
  locked,
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  date: string;
  value: string;
  options: SlotOption[];
  locked: boolean;
}) {
  return (
    <form action={setLineupSlotAction.bind(null, leagueId, teamId, playerId, date)}>
      {/* bg-white/text-black is deliberate: the native option popup ignores
          the app's dark theme and renders on the OS's own white background —
          see ViewControls.tsx for the same fix and fuller explanation. */}
      <select
        key={value}
        name="slot"
        defaultValue={value}
        disabled={locked}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded border border-border bg-white px-2 py-1 text-xs text-black disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}
