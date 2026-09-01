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
        className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
      >
        {label}
      </button>
    </form>
  );
}
