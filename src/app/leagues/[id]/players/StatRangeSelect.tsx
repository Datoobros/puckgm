"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { STAT_RANGES } from "@/lib/players/seasons";

/** Stats-range dropdown for the Players page — season + rolling options,
 * no "Daily" entry (that's tied to the team page's date strip and means
 * nothing here). Navigates by merging `range` into the current search
 * params so an in-flight name search (`q`) survives the change. */
export function StatRangeSelect({ range }: { range: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function navigate(nextRange: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", nextRange);
    router.push(`?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      Stats
      <select
        value={range}
        onChange={(e) => navigate(e.target.value)}
        className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
      >
        {STAT_RANGES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
