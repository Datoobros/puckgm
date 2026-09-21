"use client";

import { useRouter } from "next/navigation";

/** DateStrip (src/app/leagues/[id]/teams/[teamId]/DateStrip.tsx) hardcodes
 * its own basePath to the team page's URL — not reusable here, so this is a
 * plain date input instead, matching the plan's own fallback instruction. */
export function LineupDatePicker({
  leagueId,
  teamId,
  performAs,
  date,
}: {
  leagueId: string;
  teamId: string;
  performAs: string;
  date: string;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted">Date</span>
      <input
        type="date"
        value={date}
        onChange={(e) => {
          if (!e.target.value) return;
          router.push(`/leagues/${leagueId}/settings/roster-moves?action=LINEUP&team=${teamId}&as=${performAs}&date=${e.target.value}`);
        }}
        className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
      />
    </label>
  );
}
