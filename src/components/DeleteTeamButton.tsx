"use client";

import { deleteTeamAction } from "@/app/leagues/actions";

export function DeleteTeamButton({ leagueId, teamId, teamName }: { leagueId: string; teamId: string; teamName: string }) {
  return (
    <form
      action={deleteTeamAction.bind(null, leagueId, teamId)}
      onSubmit={(e) => {
        if (!confirm(`Delete "${teamName}"? This can't be undone.`)) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className="rounded-full border border-border px-3 py-1 text-xs text-red-500 hover:bg-surface-tint">
        Delete
      </button>
    </form>
  );
}
