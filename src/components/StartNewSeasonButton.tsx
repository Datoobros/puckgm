"use client";

import { startNewSeasonAction } from "@/app/leagues/actions";

export function StartNewSeasonButton({ leagueId, currentSeason }: { leagueId: string; currentSeason: number }) {
  return (
    <form
      action={startNewSeasonAction.bind(null, leagueId)}
      onSubmit={(e) => {
        if (
          !confirm(
            `Start the ${currentSeason + 1} season? Every roster on this league empties back to free agency right now — this can't be undone. You'll set up a new startup draft afterward.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
        Start New Season
      </button>
    </form>
  );
}
