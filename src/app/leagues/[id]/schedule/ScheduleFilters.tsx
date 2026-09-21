"use client";

import { useRouter } from "next/navigation";

/** Season select + Team filter for the League Schedule page — same
 * URL-driven pattern as standings/SeasonSelect.tsx and
 * scoreboard/TeamScheduleSelect.tsx, combined into one control pair since
 * ESPN renders them side by side on this page. */
export function ScheduleFilters({
  leagueId,
  season,
  availableSeasons,
  teams,
  selectedTeamId,
}: {
  leagueId: string;
  season: number;
  availableSeasons: number[];
  teams: { id: string; name: string }[];
  selectedTeamId: string;
}) {
  const router = useRouter();

  function navigate(nextSeason: number, nextTeamId: string) {
    const params = new URLSearchParams();
    params.set("season", String(nextSeason));
    if (nextTeamId) params.set("team", nextTeamId);
    router.push(`/leagues/${leagueId}/schedule?${params.toString()}`);
  }

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted">Season</span>
        <select
          value={season}
          onChange={(e) => navigate(Number(e.target.value), selectedTeamId)}
          className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        >
          {availableSeasons.map((s) => (
            <option key={s} value={s}>
              {s}-{(s + 1) % 100}
            </option>
          ))}
        </select>
      </label>
      <select
        value={selectedTeamId}
        onChange={(e) => navigate(season, e.target.value)}
        className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
      >
        <option value="">All teams</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </>
  );
}
