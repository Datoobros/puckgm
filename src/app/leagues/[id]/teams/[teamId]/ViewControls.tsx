"use client";

import { useRouter } from "next/navigation";
import { SEASONS } from "@/lib/players/seasons";

export function ViewControls({
  leagueId,
  teamId,
  date,
  view,
}: {
  leagueId: string;
  teamId: string;
  date: string;
  view: string;
}) {
  const router = useRouter();
  const basePath = `/leagues/${leagueId}/teams/${teamId}`;

  function navigate(nextDate: string, nextView: string) {
    router.push(`${basePath}?date=${nextDate}&view=${nextView}`);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        defaultValue={date}
        onChange={(e) => {
          if (e.target.value) navigate(e.target.value, view);
        }}
        className="rounded border border-black/10 bg-white px-2 py-1 text-sm text-black dark:border-white/15"
      />
      {/* bg-white/text-black is deliberate here, not a dark-mode oversight:
          the native option popup ignores our dark theme's CSS and renders
          with the OS's own white background — letting the closed control's
          text stay theme-driven made it invisible against that popup. */}
      <select
        value={view}
        onChange={(e) => navigate(date, e.target.value)}
        className="rounded border border-black/10 bg-white px-2 py-1 text-sm text-black dark:border-white/15"
      >
        <option value="daily">Daily</option>
        {SEASONS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
