"use client";

import { deleteTeamAction } from "@/app/leagues/actions";
import { Button } from "./Button";

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
      <Button type="submit" variant="danger" size="sm">
        Delete
      </Button>
    </form>
  );
}
