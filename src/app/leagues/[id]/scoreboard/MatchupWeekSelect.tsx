"use client";

import { useRouter } from "next/navigation";
import { formatPeriodRange } from "@/lib/dates";

export interface WeekOption {
  periodNo: number;
  isPlayoffs: boolean;
  roundLabel: string | null;
  startDate: Date;
  endDate: Date;
}

/** Every period in the season, so a manager can jump straight to any week
 * (past or future) instead of only stepping one at a time — replaces the
 * old Prev/Next buttons + "Week N of M" line. */
export function MatchupWeekSelect({
  leagueId,
  options,
  selectedPeriodNo,
}: {
  leagueId: string;
  options: WeekOption[];
  selectedPeriodNo: number;
}) {
  const router = useRouter();

  return (
    <select
      value={String(selectedPeriodNo)}
      onChange={(e) => router.push(`/leagues/${leagueId}/scoreboard?week=${e.target.value}`)}
      className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
    >
      {options.map((o) => {
        const range = formatPeriodRange(o.startDate, o.endDate);
        const label = o.isPlayoffs ? `${o.roundLabel} (${range})` : `Matchup ${o.periodNo} (${range})`;
        return (
          <option key={o.periodNo} value={String(o.periodNo)}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
