"use client";

import { startNewSeasonAction } from "@/app/leagues/actions";
import { Button } from "./Button";

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
      <Button type="submit" variant="danger" size="sm">
        Start New Season
      </Button>
    </form>
  );
}
