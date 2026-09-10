"use client";

import { resetScheduleAction } from "@/app/leagues/actions";
import { Button } from "./Button";

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
      <Button type="submit" variant="danger" size="sm">
        Reset schedule
      </Button>
    </form>
  );
}
