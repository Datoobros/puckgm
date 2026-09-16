// Stat-range options for the stats-view dropdown, shared by the team page
// and the Players page. Season entries are bucketed by calendar year (Aug 1
// -> Jul 31) rather than the NHL's exact regular season dates, since that's
// wide enough to safely catch preseason/playoffs on either edge without
// needing to hardcode exact start/end dates per year. Rolling entries (Last
// 7/30 Days) are resolved relative to "today" at read time.

import { todayUTC, shiftDate } from "@/lib/dates";

export type StatRangeOption =
  | { value: string; label: string; kind: "season"; start: Date; end: Date }
  | { value: string; label: string; kind: "rolling"; days: number };

export const STAT_RANGES: StatRangeOption[] = [
  { value: "last7", label: "Last 7 Days", kind: "rolling", days: 7 },
  { value: "last30", label: "Last 30 Days", kind: "rolling", days: 30 },
  { value: "2025", label: "2025-26", kind: "season", start: new Date("2025-08-01T00:00:00.000Z"), end: new Date("2026-07-31T23:59:59.999Z") },
  { value: "2026", label: "2026-27", kind: "season", start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2027-07-31T23:59:59.999Z") },
];

/**
 * Resolves a dropdown value to a concrete date range + display label.
 * `today` (a "YYYY-MM-DD" string) is injectable so scripts/tests can anchor
 * a rolling window on a date that actually has ingested data, rather than
 * the real calendar date — production callers should omit it.
 */
export function resolveStatRange(
  value: string,
  today: string = todayUTC(),
): { start: Date; end: Date; label: string } | undefined {
  const opt = STAT_RANGES.find((s) => s.value === value);
  if (!opt) return undefined;
  if (opt.kind === "season") return { start: opt.start, end: opt.end, label: opt.label };
  // Rolling window = `days` calendar days including today.
  const start = new Date(`${shiftDate(today, -(opt.days - 1))}T00:00:00.000Z`);
  const end = new Date(`${today}T23:59:59.999Z`);
  return { start, end, label: opt.label };
}
