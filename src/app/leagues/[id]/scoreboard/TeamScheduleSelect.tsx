"use client";

import { useRouter } from "next/navigation";

export function TeamScheduleSelect({
  leagueId,
  teams,
  selectedTeamId,
}: {
  leagueId: string;
  teams: { id: string; name: string }[];
  selectedTeamId: string;
}) {
  const router = useRouter();

  return (
    <select
      value={selectedTeamId}
      onChange={(e) => {
        const value = e.target.value;
        router.push(value ? `/leagues/${leagueId}/scoreboard?team=${value}` : `/leagues/${leagueId}/scoreboard`);
      }}
      className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
    >
      <option value="">Week by week</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}&apos;s schedule
        </option>
      ))}
    </select>
  );
}
