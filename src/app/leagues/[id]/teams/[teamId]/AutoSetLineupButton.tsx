"use client";

import { autoSetLineupAction } from "./actions";
import { Button } from "@/components/Button";

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
      <Button type="submit">{label}</Button>
    </form>
  );
}
