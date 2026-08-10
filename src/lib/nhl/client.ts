// Thin, typed wrappers around NHL's public (undocumented, unauthenticated) API.
// Verified reachable via plain server-side fetch — no special headers needed.
// See ../../../../DESIGN.md §4/§Risks for the source-stability caveat.

const API_BASE = "https://api-web.nhle.com/v1";
const SEARCH_BASE = "https://search.d3.nhle.com/api/v1";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
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

export interface NhlRosterPlayer {
  id: number;
  firstName: { default: string };
  lastName: { default: string };
  positionCode: string;
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

export interface NhlBoxscore {
  id: number;
  gameDate: string;
  gameState: string;
  playerByGameStats?: {
    awayTeam: NhlBoxscoreTeam;
    homeTeam: NhlBoxscoreTeam;
  };
}

export function getBoxscore(gameId: number): Promise<NhlBoxscore> {
  return getJson<NhlBoxscore>(`${API_BASE}/gamecenter/${gameId}/boxscore`);
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
