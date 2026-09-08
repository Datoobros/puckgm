"use client";

import { useRouter } from "next/navigation";

export function SeasonSelect({
  leagueId,
  season,
  div,
  availableSeasons,
}: {
  leagueId: string;
  season: number;
  div: string;
  availableSeasons: number[];
}) {
  const router = useRouter();

  function navigate(nextSeason: string) {
    const params = new URLSearchParams();
    params.set("season", nextSeason);
    if (div !== "Full") params.set("div", div);
    router.push(`/leagues/${leagueId}/standings?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted">Season</span>
      <select
        value={season}
        onChange={(e) => navigate(e.target.value)}
        className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
      >
        {availableSeasons.map((s) => (
          <option key={s} value={s}>
            {s}-{(s + 1) % 100}
          </option>
        ))}
      </select>
    </label>
  );
}
