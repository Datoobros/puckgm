// ESPN's unofficial NHL injuries feed — the only free source found for a
// real "Injured Reserve" designation (DESIGN.md §2.6 requires gating IR on
// the official transaction, never on injury severity/prognosis; the NHL's
// own public API exposes neither). Confirmed live: this feed's `status`
// field carries a literal "Injured Reserve" value distinct from vaguer ones
// ("Out", "Suspension") — only that exact value is trusted as real IR here.
//
// No ID crosswalk to our NHL-sourced player IDs exists, so matching is by
// (full name, team) against players already known from NHL data — see
// src/lib/players/injuries.ts. ESPN's own team abbreviations differ from
// ours in places (LA vs LAK, NJ vs NJD, SJ vs SJS, TB vs TBL, UTAH vs UTA),
// so team resolution goes through ESPN's numeric team id, not its
// abbreviation or display name string.

const INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";

// Verified against ESPN's own /teams endpoint — team id is the only stable
// key across the two team-naming schemes.
export const ESPN_TEAM_ID_TO_ABBREV: Record<string, string> = {
  "25": "ANA",
  "1": "BOS",
  "2": "BUF",
  "3": "CGY",
  "7": "CAR",
  "4": "CHI",
  "17": "COL",
  "29": "CBJ",
  "9": "DAL",
  "5": "DET",
  "6": "EDM",
  "26": "FLA",
  "8": "LAK",
  "30": "MIN",
  "10": "MTL",
  "27": "NSH",
  "11": "NJD",
  "12": "NYI",
  "13": "NYR",
  "14": "OTT",
  "15": "PHI",
  "16": "PIT",
  "18": "SJS",
  "124292": "SEA",
  "19": "STL",
  "20": "TBL",
  "21": "TOR",
  "129764": "UTA",
  "22": "VAN",
  "37": "VGK",
  "23": "WSH",
  "28": "WPG",
};

export interface EspnInjuryEntry {
  teamAbbrev: string | null; // null if ESPN's team id isn't in our map (shouldn't happen; defensive)
  athleteName: string;
  status: string; // "Injured Reserve" | "Out" | "Suspension" | ...
}

interface EspnInjuriesResponse {
  injuries: {
    id: string;
    injuries: { status: string; athlete: { displayName: string } }[];
  }[];
}

export async function getEspnInjuries(): Promise<EspnInjuryEntry[]> {
  const res = await fetch(INJURIES_URL);
  if (!res.ok) throw new Error(`ESPN injuries API ${res.status}`);
  const data = (await res.json()) as EspnInjuriesResponse;

  const entries: EspnInjuryEntry[] = [];
  for (const team of data.injuries) {
    const teamAbbrev = ESPN_TEAM_ID_TO_ABBREV[team.id] ?? null;
    for (const injury of team.injuries) {
      entries.push({ teamAbbrev, athleteName: injury.athlete.displayName, status: injury.status });
    }
  }
  return entries;
}
