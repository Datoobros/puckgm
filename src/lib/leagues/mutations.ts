// Plain, testable mutation functions — no "use server", no auth, no
// FormData parsing. The Server Action wrappers in src/app/leagues/actions.ts
// handle those concerns and call straight through to these. Same split used
// throughout the ingestion code: keep the actual logic importable and
// scriptable, keep the framework glue thin.

import { Prisma } from "@prisma/client";
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
  // FAAB / "the wire" (DESIGN.md §2.7/§2.9, src/lib/faab/mutations.ts) — a
  // per-league opt-in, default off. There's no draft yet, so free instant
  // add (addPlayerToRoster) has to keep working for leagues that don't turn
  // this on; enabling it blocks that path and requires a bid instead.
  faabEnabled: boolean;
  faabBudget: number; // starting/reset amount each season
  faabMinBid: number;
  faabMaxBid: number | null; // null = no cap beyond remaining budget
  // Trades (DESIGN.md §2.11, src/lib/trades/mutations.ts). tradeVetoMode is
  // "between seasons, by vote" tier (changing governance mid-season feels
  // like changing the rules mid-game); tradeDeadline is DESIGN.md §2.10's
  // "anytime" tier — a commissioner can move it whenever, it just blocks new
  // proposals after that date, it doesn't touch trades already in flight.
  tradeVetoMode: "COMMISSIONER" | "VOTE";
  tradeDeadline: string | null; // ISO date, null = no deadline
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
    faabEnabled: false,
    faabBudget: 100,
    faabMinBid: 1,
    faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER",
    tradeDeadline: null,
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
  // FaBid/FaabBudget (added with FAAB) reference Team the same way
  // RosterSlot does — same shape of bug as the Matchup/LeagueSettingsLog
  // ones found earlier, fixed proactively here instead of waiting to hit it.
  // TradeVeto/TradeItem/Trade/DraftPick (added with trades) are the same
  // shape again — TradeItem/TradeVeto reference Trade, so they go first.
  // WaiverClaim (added with waiver claims, before FAAB/trades existed) was
  // actually missed originally — same bug, caught here by a real cleanup
  // script hitting the FK violation rather than by inspection. LineupEntry
  // is the same shape again — it's existed since near the start of this
  // project (predates this teardown list entirely) and was never added;
  // caught the same way, by a playoff-bracket test script's cleanup hitting
  // the FK violation, not by inspection. A real league with any lineup
  // history would have hit this on delete too.
  await prisma.$transaction([
    prisma.matchup.deleteMany({ where: { matchupPeriod: { leagueId } } }),
    prisma.matchupPeriod.deleteMany({ where: { leagueId } }),
    prisma.leagueSettingsLog.deleteMany({ where: { leagueId } }),
    prisma.transactionLog.deleteMany({ where: { leagueId } }),
    prisma.faBid.deleteMany({ where: { team: { leagueId } } }),
    prisma.faabBudget.deleteMany({ where: { team: { leagueId } } }),
    prisma.waiverClaim.deleteMany({ where: { team: { leagueId } } }),
    prisma.tradeVeto.deleteMany({ where: { trade: { leagueId } } }),
    prisma.tradeItem.deleteMany({ where: { trade: { leagueId } } }),
    prisma.trade.deleteMany({ where: { leagueId } }),
    prisma.draftPick.deleteMany({ where: { leagueId } }),
    prisma.lineupEntry.deleteMany({ where: { team: { leagueId } } }),
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
  faabEnabled: boolean;
  faabBudget: number;
  faabMinBid: number;
  faabMaxBid: number | null;
  tradeVetoMode: "COMMISSIONER" | "VOTE";
  tradeDeadline: string | null;
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
    faabBudget: input.faabBudget,
    faabMinBid: input.faabMinBid,
  })) {
    if (!Number.isInteger(val) || val < 0) {
      throw new Error(`${key} must be a non-negative whole number.`);
    }
  }
  if (input.faabMaxBid !== null && (!Number.isInteger(input.faabMaxBid) || input.faabMaxBid < input.faabMinBid)) {
    throw new Error("faabMaxBid must be a whole number no smaller than faabMinBid, or left unset.");
  }
  if (input.tradeVetoMode !== "COMMISSIONER" && input.tradeVetoMode !== "VOTE") {
    throw new Error("tradeVetoMode must be COMMISSIONER or VOTE.");
  }
  if (input.tradeDeadline !== null && Number.isNaN(Date.parse(input.tradeDeadline))) {
    throw new Error("tradeDeadline must be a valid date, or left unset.");
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
    faabEnabled: input.faabEnabled,
    faabBudget: input.faabBudget,
    faabMinBid: input.faabMinBid,
    faabMaxBid: input.faabMaxBid,
    tradeVetoMode: input.tradeVetoMode,
    tradeDeadline: input.tradeDeadline,
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
  trackScalar("faabBudget", current.faabBudget, next.faabBudget);
  trackScalar("faabMinBid", current.faabMinBid, next.faabMinBid);
  for (const { key } of EDITABLE_SCORING_FIELDS) {
    trackScalar(`scoringConfig.${key}`, current.scoringConfig[key] ?? 0, next.scoringConfig[key] ?? 0);
  }
  if (current.faabEnabled !== next.faabEnabled) {
    logs.push({
      leagueId: input.leagueId,
      field: "faabEnabled",
      oldValue: current.faabEnabled,
      newValue: next.faabEnabled,
      changedBy: input.callerUserId,
    });
  }
  if (current.faabMaxBid !== next.faabMaxBid) {
    logs.push({
      leagueId: input.leagueId,
      field: "faabMaxBid",
      oldValue: current.faabMaxBid ?? Prisma.JsonNull,
      newValue: next.faabMaxBid ?? Prisma.JsonNull,
      changedBy: input.callerUserId,
    });
  }
  if (current.tradeVetoMode !== next.tradeVetoMode) {
    logs.push({
      leagueId: input.leagueId,
      field: "tradeVetoMode",
      oldValue: current.tradeVetoMode,
      newValue: next.tradeVetoMode,
      changedBy: input.callerUserId,
    });
  }
  if (current.tradeDeadline !== next.tradeDeadline) {
    logs.push({
      leagueId: input.leagueId,
      field: "tradeDeadline",
      oldValue: current.tradeDeadline ?? Prisma.JsonNull,
      newValue: next.tradeDeadline ?? Prisma.JsonNull,
      changedBy: input.callerUserId,
    });
  }

  await prisma.$transaction([
    prisma.league.update({
      where: { id: input.leagueId },
      data: { settingsJson: next as unknown as Prisma.InputJsonValue },
    }),
    ...(logs.length > 0 ? [prisma.leagueSettingsLog.createMany({ data: logs })] : []),
  ]);
}
