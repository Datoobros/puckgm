"use client";

import { useRouter } from "next/navigation";
import { shiftDate, todayUTC } from "@/lib/dates";

const WINDOW_SIZE = 5;
const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function DateStrip({
  leagueId,
  teamId,
  selectedDate,
  view,
}: {
  leagueId: string;
  teamId: string;
  selectedDate: string;
  view: string;
}) {
  const router = useRouter();
  const basePath = `/leagues/${leagueId}/teams/${teamId}`;

  function go(date: string) {
    router.push(`${basePath}?date=${date}&view=${view}`);
  }

  const windowDates = Array.from({ length: WINDOW_SIZE }, (_, i) => shiftDate(selectedDate, i));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-muted">Set Lineup:</span>
      <button
        type="button"
        onClick={() => go(shiftDate(selectedDate, -1))}
        aria-label="Earlier day"
        className="rounded-full border border-border px-2 py-1 text-sm hover:bg-surface-tint"
      >
        ‹
      </button>
      {windowDates.map((d) => {
        const dt = new Date(`${d}T00:00:00.000Z`);
        const isSelected = d === selectedDate;
        return (
          <button
            key={d}
            type="button"
            onClick={() => go(d)}
            className={`flex flex-col items-center rounded-lg px-3 py-1.5 text-xs ${
              isSelected ? "bg-navy text-navy-foreground" : "border border-border hover:bg-surface-tint"
            }`}
          >
            <span className="font-medium">{WEEKDAY_LABELS[dt.getUTCDay()]}</span>
            <span className="tabular-nums">
              {dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => go(shiftDate(selectedDate, 1))}
        aria-label="Later days"
        className="rounded-full border border-border px-2 py-1 text-sm hover:bg-surface-tint"
      >
        ›
      </button>
      {selectedDate !== todayUTC() && (
        <button
          type="button"
          onClick={() => go(todayUTC())}
          className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-tint"
        >
          Today
        </button>
      )}
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => e.target.value && go(e.target.value)}
        className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
        aria-label="Jump to date"
      />
    </div>
  );
}
