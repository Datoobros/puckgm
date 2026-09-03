// Plain, testable mutation functions — no "use server", no auth, no
// FormData parsing. The Server Action wrappers in src/app/leagues/actions.ts
// handle those concerns and call straight through to these. Same split used
// throughout the ingestion code: keep the actual logic importable and
// scriptable, keep the framework glue thin.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { STARTER_SCORING, EDITABLE_SCORING_FIELDS, type ScoringConfig } from "@/lib/scoring/engine";

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
      commissionerUserId: input.managerUserId,
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

/** Every team a user manages, across every league — the home dashboard's
 * "Your Teams" list. */
export async function getTeamsForUser(userId: string) {
  return prisma.team.findMany({
    where: { managerUserId: userId },
    include: { league: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Leagues created before commissionerUserId existed have it as null —
 * fall back to whoever created the earliest team as the inferred owner. */
export async function getLeagueCommissioner(leagueId: string): Promise<string | null> {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) return null;
  if (league.commissionerUserId) return league.commissionerUserId;
  const earliestTeam = await prisma.team.findFirst({
    where: { leagueId },
    orderBy: { createdAt: "asc" },
  });
  return earliestTeam?.managerUserId ?? null;
}

export async function deleteLeague(leagueId: string, callerUserId: string): Promise<void> {
  const commissioner = await getLeagueCommissioner(leagueId);
  if (!commissioner || commissioner !== callerUserId) {
    throw new Error("Only the league commissioner can delete this league.");
  }

  // Same deletion order used throughout the test-cleanup scripts this
  // session — every child here has a real FK constraint back to League or
  // Team with no cascade configured, so children go first. Matchup
  // references both MatchupPeriod and Team, so it has to go before either.
  await prisma.$transaction([
    prisma.matchup.deleteMany({ where: { matchupPeriod: { leagueId } } }),
    prisma.matchupPeriod.deleteMany({ where: { leagueId } }),
    prisma.leagueSettingsLog.deleteMany({ where: { leagueId } }),
    prisma.transactionLog.deleteMany({ where: { leagueId } }),
    prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } }),
    prisma.team.deleteMany({ where: { leagueId } }),
    prisma.league.delete({ where: { id: leagueId } }),
  ]);
}

export interface UpdateLeagueSettingsInput {
  leagueId: string;
  callerUserId: string;
  farmSlots: number;
  irSlots: number;
  waiverGpThreshold: number;
  callupsPerWeek: number;
  scoringConfig: ScoringConfig;
}

// DESIGN.md §2.10: farm/IR slots, scoring values, and the waiver GP
// threshold are "between seasons, by vote" — real gameplay-affecting
// settings, unlike roster composition/league size/scoring format, which
// stay permanently locked (no edit path exists for those, deliberately —
// that's what makes "locked" true). This app has no real voting system, so
// "by vote" isn't enforced here beyond commissioner-only access; the UI
// says so rather than pretending consent was collected.
export async function updateLeagueSettings(input: UpdateLeagueSettingsInput): Promise<void> {
  const commissioner = await getLeagueCommissioner(input.leagueId);
  if (!commissioner || commissioner !== input.callerUserId) {
    throw new Error("Only the league commissioner can change league settings.");
  }

  const league = await prisma.league.findUnique({ where: { id: input.leagueId } });
  if (!league) throw new Error("League not found.");
  const current = league.settingsJson as unknown as LeagueSettings;

  for (const [key, val] of Object.entries({
    farmSlots: input.farmSlots,
    irSlots: input.irSlots,
    waiverGpThreshold: input.waiverGpThreshold,
    callupsPerWeek: input.callupsPerWeek,
  })) {
    if (!Number.isInteger(val) || val < 0) {
      throw new Error(`${key} must be a non-negative whole number.`);
    }
  }
  // scoringConfig is a partial update merged onto the current config below
  // (STARTER_SCORING itself leaves giveaways/takeaways unset) — only
  // validate fields the caller actually supplied, not every editable field.
  for (const { key } of EDITABLE_SCORING_FIELDS) {
    const val = input.scoringConfig[key];
    if (val === undefined) continue;
    if (typeof val !== "number" || Number.isNaN(val)) {
      throw new Error(`Scoring value for "${key}" must be a number.`);
    }
  }

  const next: LeagueSettings = {
    ...current,
    farmSlots: input.farmSlots,
    irSlots: input.irSlots,
    waiverGpThreshold: input.waiverGpThreshold,
    callupsPerWeek: input.callupsPerWeek,
    scoringConfig: { ...current.scoringConfig, ...input.scoringConfig },
  };

  const logs: Prisma.LeagueSettingsLogCreateManyInput[] = [];
  const trackScalar = (field: string, oldValue: number, newValue: number) => {
    if (oldValue !== newValue) {
      logs.push({ leagueId: input.leagueId, field, oldValue, newValue, changedBy: input.callerUserId });
    }
  };
  trackScalar("farmSlots", current.farmSlots, next.farmSlots);
  trackScalar("irSlots", current.irSlots, next.irSlots);
  trackScalar("waiverGpThreshold", current.waiverGpThreshold, next.waiverGpThreshold);
  trackScalar("callupsPerWeek", current.callupsPerWeek, next.callupsPerWeek);
  for (const { key } of EDITABLE_SCORING_FIELDS) {
    trackScalar(`scoringConfig.${key}`, current.scoringConfig[key] ?? 0, next.scoringConfig[key] ?? 0);
  }

  await prisma.$transaction([
    prisma.league.update({
      where: { id: input.leagueId },
      data: { settingsJson: next as unknown as Prisma.InputJsonValue },
    }),
    ...(logs.length > 0 ? [prisma.leagueSettingsLog.createMany({ data: logs })] : []),
  ]);
}
