"use client";

import { autoSetLineupAction } from "./actions";

export function AutoSetLineupButton({
  leagueId,
  teamId,
  dates,
  label,
  confirmText,
}: {
  leagueId: string;
  teamId: string;
  dates: string[];
  label: string;
  confirmText: string;
}) {
  return (
    <form
      action={autoSetLineupAction.bind(null, leagueId, teamId, dates)}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      <button
        type="submit"
        className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint"
      >
        {label}
      </button>
    </form>
  );
}
