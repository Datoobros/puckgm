// Season boundaries for the stats-view dropdown on the team page. Bucketed
// by calendar year (Aug 1 -> Jul 31) rather than the NHL's exact regular
// season dates, since that's wide enough to safely catch preseason/playoffs
// on either edge without needing to hardcode exact start/end dates per year.

export interface SeasonOption {
  value: string;
  label: string;
  start: Date;
  end: Date;
}

export const SEASONS: SeasonOption[] = [
  { value: "2025", label: "2025-26", start: new Date("2025-08-01T00:00:00.000Z"), end: new Date("2026-07-31T23:59:59.999Z") },
  { value: "2026", label: "2026-27", start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2027-07-31T23:59:59.999Z") },
];

export function seasonByValue(value: string): SeasonOption | undefined {
  return SEASONS.find((s) => s.value === value);
}
