// Plain, testable mutation functions — no "use server", no auth, no
// FormData parsing. The Server Action wrappers in src/app/leagues/actions.ts
// handle those concerns and call straight through to these. Same split used
// throughout the ingestion code: keep the actual logic importable and
// scriptable, keep the framework glue thin.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { STARTER_SCORING } from "@/lib/scoring/engine";

export interface RosterComposition {
  C: number;
  LW: number;
  RW: number;
  D: number;
  G: number;
  UTIL: number;
  BENCH: number;
}

// Settings shape stored in League.settingsJson. Mutability tiers per
// DESIGN.md §2.10 — this shell builds NO edit path for any of these fields,
// which is what actually makes "locked at creation" true today. Enforcing it
// with a permissions system is future work for whenever an edit path exists.
export interface LeagueSettings {
  scoringFormat: "H2H_POINTS"; // only supported value right now
  leagueSize: number;
  rosterComposition: RosterComposition;
  farmSlots: number;
  irSlots: number;
  waiverGpThreshold: number; // DESIGN.md §2.3 — 80 GP default
  callupsPerWeek: number;
  scoringConfig: typeof STARTER_SCORING;
}

export interface CreateLeagueInput {
  name: string;
  season: number;
  managerUserId: string;
  teamName: string;
  rosterComposition: RosterComposition;
  farmSlots: number;
  irSlots: number;
}

export async function createLeague(input: CreateLeagueInput): Promise<{ leagueId: string; teamId: string }> {
  const settings: LeagueSettings = {
    scoringFormat: "H2H_POINTS",
    leagueSize: 12,
    rosterComposition: input.rosterComposition,
    farmSlots: input.farmSlots,
    irSlots: input.irSlots,
    waiverGpThreshold: 80,
    callupsPerWeek: 2,
    scoringConfig: STARTER_SCORING,
  };

  const league = await prisma.league.create({
    data: {
      name: input.name,
      seasonFounded: input.season,
      settingsJson: settings as unknown as Prisma.InputJsonValue,
      teams: {
        create: {
          name: input.teamName,
          managerUserId: input.managerUserId,
        },
      },
    },
    include: { teams: true },
  });

  return { leagueId: league.id, teamId: league.teams[0].id };
}

export interface CreateTeamInput {
  leagueId: string;
  managerUserId: string;
  teamName: string;
}

export async function createTeam(input: CreateTeamInput): Promise<{ teamId: string }> {
  const existing = await prisma.team.findFirst({
    where: { leagueId: input.leagueId, managerUserId: input.managerUserId },
  });
  if (existing) {
    throw new Error("You already have a team in this league.");
  }

  const team = await prisma.team.create({
    data: {
      leagueId: input.leagueId,
      name: input.teamName,
      managerUserId: input.managerUserId,
    },
  });
  return { teamId: team.id };
}

export async function listLeagues() {
  return prisma.league.findMany({
    orderBy: { createdAt: "desc" },
    include: { teams: true },
  });
}

export async function getLeague(leagueId: string) {
  return prisma.league.findUnique({
    where: { id: leagueId },
    include: { teams: true },
  });
}
