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
