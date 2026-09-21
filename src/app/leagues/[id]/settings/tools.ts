// Registry for the League Manager Tools hub (plans/lm-tools-batch.md). A row
// without `href` renders as a muted "Coming soon" line on the hub instead of
// a link — later tasks add hrefs as each tool actually ships. Adding a new
// tool later is just adding one row object here.

export interface LmToolRow {
  title: string;
  description: string;
  href?: (leagueId: string) => string;
}

export interface LmToolCard {
  title: string;
  rows: LmToolRow[];
}

export const LM_TOOL_CARDS: LmToolCard[] = [
  {
    title: "League Membership Tools",
    rows: [
      {
        title: "Edit Managers and Send Invitations",
        description: "Reassign, orphan, or invite managers for any team in your league.",
        href: (leagueId) => `/leagues/${leagueId}/settings/managers`,
      },
      {
        title: "Assign League Manager Powers",
        description: "Grant or revoke co-commissioner access for other managers.",
        href: (leagueId) => `/leagues/${leagueId}/settings/powers`,
      },
    ],
  },
  {
    title: "Draft Tools",
    rows: [
      {
        title: "Draft Recap",
        description: "View a summary of all draft picks.",
        href: (leagueId) => `/leagues/${leagueId}/draft/recap`,
      },
      {
        title: "Draft Settings",
        description: "Set up or edit an upcoming startup or rookie draft.",
        href: (leagueId) => `/leagues/${leagueId}/settings/draft-settings`,
      },
      {
        title: "Reset Draft",
        description: "Roll back a draft and start over.",
        href: (leagueId) => `/leagues/${leagueId}/settings/reset-draft`,
      },
    ],
  },
  {
    title: "League and Scoring Settings Tools",
    rows: [
      {
        title: "Edit League Settings",
        description: "Manage FAAB, trade rules, and other league-wide settings.",
        href: (leagueId) => `/leagues/${leagueId}/settings/league`,
      },
      {
        title: "Edit Scoring Settings",
        description: "Adjust the points awarded for each statistical category.",
        href: (leagueId) => `/leagues/${leagueId}/settings/scoring`,
      },
      {
        title: "Edit Teams and Divisions",
        description: "Rename teams and organize them into divisions.",
        href: (leagueId) => `/leagues/${leagueId}/settings/teams-divisions`,
      },
      {
        title: "Delete League",
        description: "Permanently delete this league and all of its data.",
        href: (leagueId) => `/leagues/${leagueId}/settings/delete`,
      },
      {
        title: "Adjust Scoring",
        description: "Manually adjust a team's score for a given matchup.",
        href: (leagueId) => `/leagues/${leagueId}/scoreboard`,
      },
    ],
  },
  {
    title: "Roster Tools",
    rows: [
      {
        title: "Edit Roster Settings",
        description: "Set farm/IR slots, callup limits, and roster composition.",
        href: (leagueId) => `/leagues/${leagueId}/settings/roster-settings`,
      },
      {
        title: "Roster Moves",
        description: "Add, drop, or move players on any team's roster.",
        href: (leagueId) => `/leagues/${leagueId}/settings/roster-moves`,
      },
      {
        title: "Trade Review",
        description: "Review, veto, or force through pending trades.",
        href: (leagueId) => `/leagues/${leagueId}/settings/trade-review`,
      },
      {
        title: "Edit Waiver Order",
        description: "Change the waiver priority order for your league.",
        href: (leagueId) => `/leagues/${leagueId}/settings/waiver-order`,
      },
    ],
  },
  {
    title: "Schedule and Standings Tools",
    rows: [
      {
        title: "Edit Schedule Settings",
        description: "Generate or reset the regular-season and playoff schedule.",
        href: (leagueId) => `/leagues/${leagueId}/settings/schedule-settings`,
      },
      {
        title: "Edit Head-to-Head Schedule",
        description: "Edit any upcoming matchup pairing in the league schedule.",
        href: (leagueId) => `/leagues/${leagueId}/schedule`,
      },
    ],
  },
  {
    title: "Miscellaneous Tools",
    rows: [],
  },
];
