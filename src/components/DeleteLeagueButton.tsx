"use client";

import { deleteLeagueAction } from "@/app/leagues/actions";
import { Button } from "./Button";

export function DeleteLeagueButton({ leagueId, leagueName }: { leagueId: string; leagueName: string }) {
  return (
    <form
      action={deleteLeagueAction.bind(null, leagueId)}
      onSubmit={(e) => {
        if (!confirm(`Delete "${leagueName}"? This removes every team and roster in it. This can't be undone.`)) {
          e.preventDefault();
        }
      }}
    >
      <Button type="submit" variant="danger" size="sm">
        Delete league
      </Button>
    </form>
  );
}
