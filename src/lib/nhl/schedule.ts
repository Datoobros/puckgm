// Shared parser for NHL's schedule-by-date endpoint. Used by the daily
// ingest job (which games finished) and by the lineup feature (which teams
// play today, and when their game locks) — pulled out once a second caller
// needed the same fetch/parse the ingest job already had.

export interface NhlScheduleGame {
  id: number;
  gameType: number; // 1 preseason, 2 regular, 3 playoffs
  gameState: string; // FUT | PRE | LIVE | CRIT | OFF | ...
  startTimeUTC: string;
  awayTeam: { abbrev: string };
  homeTeam: { abbrev: string };
}

interface NhlDaySchedule {
  gameWeek: { date: string; games: NhlScheduleGame[] }[];
}

/** date must be "YYYY-MM-DD". Every game scheduled that day, any gameType. */
export async function getDaySchedule(date: string): Promise<NhlScheduleGame[]> {
  const res = await fetch(`https://api-web.nhle.com/v1/schedule/${date}`);
  // A date outside the NHL's currently published window (e.g. more than a
  // season or so out) 404s — that's "no schedule published yet," not an
  // error, and day-cycling on the team page can reach dates like that just
  // by clicking Next repeatedly. Any other non-OK status is a real failure.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`NHL schedule API ${res.status} for ${date}`);
  const data = (await res.json()) as NhlDaySchedule;
  return data.gameWeek.find((d) => d.date === date)?.games ?? [];
}
