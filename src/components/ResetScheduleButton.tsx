"use client";

import { resetScheduleAction } from "@/app/leagues/actions";

export function ResetScheduleButton({ leagueId, season }: { leagueId: string; season: number }) {
  return (
    <form
      action={resetScheduleAction.bind(null, leagueId, season)}
      onSubmit={(e) => {
        if (!confirm(`Delete the ${season} schedule entirely so you can generate a new one? This can't be undone (and is refused if any week has already been played).`)) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
        Reset schedule
      </button>
    </form>
  );
}
