"use client";

import { useRouter } from "next/navigation";

export function DateJump({ leagueId, teamId, date }: { leagueId: string; teamId: string; date: string }) {
  const router = useRouter();
  return (
    <input
      type="date"
      defaultValue={date}
      onChange={(e) => {
        if (e.target.value) router.push(`/leagues/${leagueId}/teams/${teamId}/lineup?date=${e.target.value}`);
      }}
      className="rounded border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/15"
    />
  );
}
