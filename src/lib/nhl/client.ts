// Thin, typed wrappers around NHL's public (undocumented, unauthenticated) API.
// Verified reachable via plain server-side fetch — no special headers needed.
// See ../../../../DESIGN.md §4/§Risks for the source-stability caveat.

import { acquire, reportRateLimited, NhlRateLimitedError } from "@/lib/nhl/pacer";

const API_BASE = "https://api-web.nhle.com/v1";
const SEARCH_BASE = "https://search.d3.nhle.com/api/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 is deliberately NOT here — see pacer.ts and
// plans/live-tracking-batch.md's "What Task 4b left behind." Retrying a 429
// with backoff (ingest-reliability Task 1's original approach) was
// counterproductive for bulk work: a volume-based limiter isn't cleared by
// a few seconds of backoff, the retry itself adds to the volume that
// tripped it, and every doomed retry pays the full backoff cost — measured
// at careerGp spending ~50s to refresh 1-4 of 40 players. 429 is now handled
// up front by the shared pacer's circuit breaker (pacedFetch below) instead
// of here. Do not add 429 back to this set; that would restore the bug.
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

const RETRY_BACKOFFS_MS = [500, 1000, 2000];

// Every NHL request — including each retry attempt — goes through the
// shared pacer, and a real 429 trips its circuit breaker and throws
// NhlRateLimitedError rather than returning a response. Callers must let
// that propagate (see careerGp.ts/sync.ts/daily.ts's fan-out-stop logic)
// rather than catching it as a generic failure.
async function pacedFetch(url: string): Promise<Response> {
  await acquire();
  const res = await fetch(url);
  if (res.status === 429) {
    reportRateLimited();
    throw new NhlRateLimitedError(`NHL API rate limited (429) for ${url}`);
  }
  return res;
}

/** Retries on 5xx only — a 404 or other 4xx is a real answer, not a
 * transient failure, and callers (getDaySchedule in particular) depend on
 * that distinction. Backs off 500ms -> 1s -> 2s, honoring a `Retry-After`
 * header when present and <= 5s. Exported so schedule.ts's getDaySchedule
 * can share it rather than duplicating the backoff logic. */
export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let res = await pacedFetch(url);
  for (let i = 0; i < attempts && !res.ok && isRetryableStatus(res.status); i++) {
    const retryAfterSeconds = Number(res.headers.get("Retry-After"));
    const backoff = RETRY_BACKOFFS_MS[i] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1];
    const delay =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds * 1000 <= 5000
        ? retryAfterSeconds * 1000
        : backoff;
    await sleep(delay);
    res = await pacedFetch(url);
  }
  return res;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`NHL API ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

export interface NhlSearchResult {
  playerId: string;
  name: string;
  positionCode: string;
  teamAbbrev: string | null;
  lastTeamAbbrev: string | null;
  lastSeasonId: string | null;
  active: boolean;
}

export function searchPlayers(query: string): Promise<NhlSearchResult[]> {
  const url = `${SEARCH_BASE}/search/player?culture=en-us&limit=10&q=${encodeURIComponent(query)}`;
  return getJson<NhlSearchResult[]>(url);
}

export interface NhlSeasonTotal {
  season: number;
  gameTypeId: number;
  leagueAbbrev: string;
  teamName?: { default: string };
  gamesPlayed: number;
  goals?: number;
  assists?: number;
  points?: number;
  pim?: number;
  plusMinus?: number;
  [stat: string]: unknown;
}

export interface NhlPlayerLanding {
  playerId: number;
  isActive: boolean;
  currentTeamAbbrev?: string;
  firstName: { default: string };
  lastName: { default: string };
  position: string;
  shootsCatches?: string;
  birthDate?: string;
  headshot?: string; // full CDN URL, ready to use directly — no need to construct it
  draftDetails?: {
    year: number;
    teamAbbrev: string;
    round: number;
    pickInRound: number;
    overallPick: number;
  };
  careerTotals?: {
    regularSeason?: { gamesPlayed?: number };
  };
  seasonTotals?: NhlSeasonTotal[];
}

export function getPlayerLanding(nhlPlayerId: number): Promise<NhlPlayerLanding> {
  return getJson<NhlPlayerLanding>(`${API_BASE}/player/${nhlPlayerId}/landing`);
}

// Previously declared with only 4 fields — same understatement bug as
// NhlBoxscore/NhlPlayerLanding had (see the player-modal batch's Task 1):
// the endpoint always returned far more, this type just didn't say so. The
// roster payload turns out to carry everything upsertPlayerFromRoster needs
// except careerNhlGp (src/lib/players/identity.ts), which is why roster sync
// no longer has to hit the landing endpoint once per player (see
// src/lib/players/sync.ts and the ingest-reliability-batch plan's Task 4b).
export interface NhlRosterPlayer {
  id: number;
  headshot?: string; // full CDN URL, same as NhlPlayerLanding.headshot
  firstName: { default: string };
  lastName: { default: string };
  sweaterNumber?: number;
  positionCode: string;
  shootsCatches?: string;
  birthDate?: string;
  heightInInches?: number;
  weightInPounds?: number;
}

export interface NhlRoster {
  forwards: NhlRosterPlayer[];
  defensemen: NhlRosterPlayer[];
  goalies: NhlRosterPlayer[];
}

export function getTeamRoster(teamAbbrev: string, season?: number): Promise<NhlRoster> {
  const seasonPart = season ?? "current";
  return getJson<NhlRoster>(`${API_BASE}/roster/${teamAbbrev}/${seasonPart}`);
}

export interface NhlScheduledGame {
  id: number;
  season: number;
  gameType: number; // 1 preseason, 2 regular, 3 playoffs
  gameDate: string;
  gameState: string; // "OFF" = final, "FUT" = future, "LIVE" = in progress
}

export function getClubSchedule(
  teamAbbrev: string,
  season: number,
): Promise<{ games: NhlScheduledGame[] }> {
  return getJson<{ games: NhlScheduledGame[] }>(
    `${API_BASE}/club-schedule-season/${teamAbbrev}/${season}`,
  );
}

export interface NhlBoxscorePlayer {
  playerId: number;
  name: { default: string };
  position: string;
  [stat: string]: unknown;
}

export interface NhlBoxscoreTeam {
  forwards?: NhlBoxscorePlayer[];
  defense?: NhlBoxscorePlayer[];
  goalies?: NhlBoxscorePlayer[];
}

export interface NhlBoxscoreTeamSide {
  id: number;
  abbrev: string;
  score?: number;
}

export interface NhlBoxscore {
  id: number;
  gameDate: string;
  gameState: string;
  awayTeam: NhlBoxscoreTeamSide;
  homeTeam: NhlBoxscoreTeamSide;
  gameOutcome?: { lastPeriodType?: string };
  playerByGameStats?: {
    awayTeam: NhlBoxscoreTeam;
    homeTeam: NhlBoxscoreTeam;
  };
}

export function getBoxscore(gameId: number): Promise<NhlBoxscore> {
  return getJson<NhlBoxscore>(`${API_BASE}/gamecenter/${gameId}/boxscore`);
}

export interface NhlDraftPick {
  round: number;
  pickInRound: number;
  overallPick: number;
  teamAbbrev: string;
  firstName: { default: string };
  lastName: { default: string };
  positionCode: string;
  amateurLeague?: string;
  amateurClubName?: string;
}

export interface NhlDraftClass {
  draftYear: number;
  picks: NhlDraftPick[];
}

// No player ID in this payload — these are pre-NHL prospects, nothing to
// cross-reference yet. See src/lib/players/draftClass.ts for how that's
// handled (a synthetic PlayerSourceId instead of a real NHL one).
export function getDraftClass(year: number): Promise<NhlDraftClass> {
  return getJson<NhlDraftClass>(`${API_BASE}/draft/picks/${year}/all`);
}

// Stable enough to hardcode — NHL franchise abbreviations change on relocation
// only (last one: Arizona -> Utah, 2024). Revisit if any ingestion job starts
// silently missing a team.
export const NHL_TEAM_ABBREVS = [
  "ANA", "BOS", "BUF", "CGY", "CAR", "CHI", "COL", "CBJ",
  "DAL", "DET", "EDM", "FLA", "LAK", "MIN", "MTL", "NSH",
  "NJD", "NYI", "NYR", "OTT", "PHI", "PIT", "SEA", "SJS",
  "STL", "TBL", "TOR", "UTA", "VAN", "VGK", "WSH", "WPG",
] as const;

// Full team names for the player-profile modal's header card — every
// abbrev in NHL_TEAM_ABBREVS has an entry (checked by
// scripts/player-profile-check.ts).
export const NHL_TEAM_NAMES: Record<string, string> = {
  ANA: "Anaheim Ducks",
  BOS: "Boston Bruins",
  BUF: "Buffalo Sabres",
  CGY: "Calgary Flames",
  CAR: "Carolina Hurricanes",
  CHI: "Chicago Blackhawks",
  COL: "Colorado Avalanche",
  CBJ: "Columbus Blue Jackets",
  DAL: "Dallas Stars",
  DET: "Detroit Red Wings",
  EDM: "Edmonton Oilers",
  FLA: "Florida Panthers",
  LAK: "Los Angeles Kings",
  MIN: "Minnesota Wild",
  MTL: "Montreal Canadiens",
  NSH: "Nashville Predators",
  NJD: "New Jersey Devils",
  NYI: "New York Islanders",
  NYR: "New York Rangers",
  OTT: "Ottawa Senators",
  PHI: "Philadelphia Flyers",
  PIT: "Pittsburgh Penguins",
  SEA: "Seattle Kraken",
  SJS: "San Jose Sharks",
  STL: "St. Louis Blues",
  TBL: "Tampa Bay Lightning",
  TOR: "Toronto Maple Leafs",
  UTA: "Utah Mammoth",
  VAN: "Vancouver Canucks",
  VGK: "Vegas Golden Knights",
  WSH: "Washington Capitals",
  WPG: "Winnipeg Jets",
};

export function nhlTeamLogoUrl(abbrev: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbrev}_light.svg`;
}
