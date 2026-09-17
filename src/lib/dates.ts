// Plain date-string helpers, safe to import from both server and client
// components — no server-only dependencies. "YYYY-MM-DD", UTC throughout.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Sep 29 - Oct 4", or "Oct 5 - 11" when both dates fall in the same UTC
 * month/year (no point repeating the month twice) — matches the reference
 * ESPN screenshot's hyphen style exactly. Shared by the Scoreboard's week
 * selector (scoreboard-batch Task 1) and the Matchup detail page's subtitle
 * (Task 2), so the two never drift into two different date formats. */
export function formatPeriodRange(start: Date, end: Date): string {
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const endLabel = end.toLocaleDateString(
    "en-US",
    sameMonth ? { day: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" },
  );
  return `${startLabel} - ${endLabel}`;
}
