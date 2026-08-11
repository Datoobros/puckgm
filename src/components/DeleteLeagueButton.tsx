"use client";

import { deleteLeagueAction } from "@/app/leagues/actions";

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
      <button type="submit" className="text-xs text-red-500 underline">
        Delete league
      </button>
    </form>
  );
}
