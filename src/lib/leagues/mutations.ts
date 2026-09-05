// Plain, testable mutation functions — no "use server", no auth, no
// FormData parsing. The Server Action wrappers in src/app/leagues/actions.ts
// handle those concerns and call straight through to these. Same split used
// throughout the ingestion code: keep the actual logic importable and
// scriptable, keep the framework glue thin.

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { STARTER_SCORING, EDITABLE_SCORING_FIELDS, type ScoringConfig } from "@/lib/scoring/engine";

export interface RosterComposition {
  // Locked at creation, like every other field here. SEPARATE keeps C/LW/RW
  // as distinct starting slots (F stays 0); COMBINED folds them into one "F"
  // (Forwards) slot instead (C/LW/RW all stay 0). src/lib/lineups/mutations.ts
  // is where this actually changes lineup-slot eligibility.
  positionMode: "SEPARATE" | "COMBINED";
  C: number;
  LW: number;
  RW: number;
  F: number;
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
  // Locked at creation. DYNASTY is this app's original, only-ever-built
  // model: a farm team, rosters persist across seasons indefinitely. REDRAFT
  // has no farm team (farmSlots is forced to 0 both at creation and in
  // updateLeagueSettings) and instead resets every roster to free agency via
  // startNewSeason, which the commissioner triggers once a season is over.
  leagueType: "DYNASTY" | "REDRAFT";
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
  // Commissioner tools. Default true — draft picks are tradeable the moment
  // they exist (src/lib/draft/mutations.ts) unless a league turns this off.
  draftPickTradingEnabled: boolean;
}

export interface CreateLeagueInput {
  name: string;
  season: number;
  managerUserId: string;
  teamName: string;
  leagueType: "DYNASTY" | "REDRAFT";
  rosterComposition: RosterComposition;
  farmSlots: number;
  irSlots: number;
}

export async function createLeague(input: CreateLeagueInput): Promise<{ leagueId: string; teamId: string }> {
  // REDRAFT has no farm team — forced here regardless of what was submitted,
  // not just hidden in the creation form (defense in depth).
  const farmSlots = input.leagueType === "REDRAFT" ? 0 : input.farmSlots;

  const settings: LeagueSettings = {
    scoringFormat: "H2H_POINTS",
    leagueSize: 12,
    leagueType: input.leagueType,
    rosterComposition: input.rosterComposition,
    farmSlots,
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
    draftPickTradingEnabled: true,
  };

  const league = await prisma.league.create({
    data: {
      name: input.name,
      seasonFounded: input.season,
      currentSeason: input.season,
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

export async function renameTeam(input: { leagueId: string; teamId: string; callerUserId: string; name: string }): Promise<void> {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  const isOwner = team.managerUserId === input.callerUserId;
  if (!isOwner && !(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only this team's manager or the league commissioner can rename it.");
  }
  const name = input.name.trim();
  if (!name) throw new Error("Team name is required.");
  await prisma.team.update({ where: { id: input.teamId }, data: { name } });
}

/** A commissioner-created placeholder team — owned by the commissioner
 * administratively (not as a second roster of their own) until claimed via
 * regenerateTeamClaimCode below. No "already has a team" check, unlike
 * createTeam — the commissioner may run several placeholders at once. */
export async function addTeamAsCommissioner(input: { leagueId: string; callerUserId: string; teamName: string }): Promise<{ teamId: string }> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can add a team.");
  }
  const teamName = input.teamName.trim();
  if (!teamName) throw new Error("Team name is required.");
  const team = await prisma.team.create({
    data: { leagueId: input.leagueId, name: teamName, managerUserId: input.callerUserId },
  });
  return { teamId: team.id };
}

/** Reassigns a team to a real person, or marks it ORPHAN_FROZEN (abandoned
 * — frozen out of trades/roster moves/waivers/FAAB until reassigned; see
 * the state checks added throughout src/lib/rosters, lineups, waivers,
 * faab). Exactly one of newManagerUserId/orphan should be passed. */
export async function setTeamManager(input: { leagueId: string; teamId: string; callerUserId: string; newManagerUserId?: string; orphan?: boolean }): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can reassign a team's manager.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");

  if (input.orphan) {
    await prisma.team.update({ where: { id: input.teamId }, data: { state: "ORPHAN_FROZEN" } });
    return;
  }
  if (!input.newManagerUserId) throw new Error("A new manager is required unless orphaning the team.");
  const existing = await prisma.team.findFirst({
    where: { leagueId: input.leagueId, managerUserId: input.newManagerUserId, id: { not: input.teamId } },
  });
  if (existing) throw new Error("That person already manages a team in this league.");
  await prisma.team.update({ where: { id: input.teamId }, data: { managerUserId: input.newManagerUserId, state: "ACTIVE" } });
}

/** Per-team join link (distinct from League.inviteCode, which creates a
 * NEW team) — lets a specific commissioner-added or newly-orphaned team be
 * claimed by a real person. Regenerating invalidates the old link, the
 * only revocation mechanism, same pattern as the league-wide invite. */
export async function regenerateTeamClaimCode(input: { leagueId: string; teamId: string; callerUserId: string }): Promise<{ claimCode: string }> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can manage a team's claim link.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  const claimCode = randomBytes(9).toString("base64url");
  await prisma.team.update({ where: { id: input.teamId }, data: { claimCode } });
  return { claimCode };
}

export async function getTeamByClaimCode(claimCode: string) {
  return prisma.team.findUnique({ where: { claimCode }, include: { league: true } });
}

/** Unlike the league-wide invite (reusable — many people join a league off
 * one link), a team claim code is single-use: claiming clears it, so the
 * same link can't later hijack the team from whoever just claimed it. */
export async function claimTeam(input: { claimCode: string; newManagerUserId: string }): Promise<{ leagueId: string; teamId: string }> {
  const team = await getTeamByClaimCode(input.claimCode);
  if (!team) throw new Error("This claim link is invalid or has been revoked.");
  const existing = await prisma.team.findFirst({ where: { leagueId: team.leagueId, managerUserId: input.newManagerUserId } });
  if (existing) throw new Error("You already manage a team in this league.");
  await prisma.team.update({
    where: { id: team.id },
    data: { managerUserId: input.newManagerUserId, state: "ACTIVE", claimCode: null },
  });
  return { leagueId: team.leagueId, teamId: team.id };
}

/** Display/standings-grouping only (src/lib/matchups/standings.ts) —
 * deliberately not wired into schedule generation or playoff seeding.
 * Blank/whitespace-only clears the division (null = no division). */
export async function setTeamDivision(input: { leagueId: string; teamId: string; callerUserId: string; division: string | null }): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can set a team's division.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  const division = input.division?.trim() || null;
  await prisma.team.update({ where: { id: input.teamId }, data: { division } });
}

/** Only permitted when the team is completely untouched — a fresh team
 * someone joined by mistake. Anything with real history (a roster ever,
 * draft picks, trades, waivers, FAAB, lineups, or even just a generated
 * schedule) gets orphaned/reassigned via setTeamManager instead, never
 * hard-deleted. Schedule generation alone (no roster activity needed) can
 * already put a "fresh" team into Matchup rows, so that check matters too. */
/** Whether a team has any real history at all — the bar deleteTeam uses to
 * decide hard-delete vs. orphan/reassign instead. Exported so the Settings
 * UI can show/disable the Delete control with a reason before the caller
 * even tries. */
export async function teamHasHistory(teamId: string): Promise<boolean> {
  const [rosterCount, draftPickCount, tradeItemCount, faBidCount, faabBudgetCount, waiverClaimCount, lineupCount, tradeVetoCount, matchupCount] =
    await Promise.all([
      prisma.rosterSlot.count({ where: { teamId } }),
      prisma.draftPick.count({ where: { OR: [{ originalTeamId: teamId }, { currentOwnerId: teamId }] } }),
      prisma.tradeItem.count({ where: { OR: [{ fromTeamId: teamId }, { toTeamId: teamId }] } }),
      prisma.faBid.count({ where: { teamId } }),
      prisma.faabBudget.count({ where: { teamId } }),
      prisma.waiverClaim.count({ where: { teamId } }),
      prisma.lineupEntry.count({ where: { teamId } }),
      prisma.tradeVeto.count({ where: { teamId } }),
      prisma.matchup.count({ where: { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] } }),
    ]);
  return (
    rosterCount + draftPickCount + tradeItemCount + faBidCount + faabBudgetCount + waiverClaimCount + lineupCount + tradeVetoCount + matchupCount > 0
  );
}

export async function deleteTeam(input: { leagueId: string; teamId: string; callerUserId: string }): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can delete a team.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");

  if (await teamHasHistory(input.teamId)) {
    throw new Error("This team has real history (roster, draft picks, trades, waivers, FAAB, or a schedule) — orphan or reassign it instead of deleting.");
  }
  await prisma.team.delete({ where: { id: input.teamId } });
}

/** The join gate for item 6: the site itself stays open to any signed-in
 * user, but joining a specific league requires this link. Reusable and
 * non-expiring by design — multiple managers join off one link, and
 * createTeam()'s existing one-team-per-manager-per-league check is the real
 * guard. Regenerating overwrites the old code, which is the only revocation
 * mechanism. Works whether inviteCode is currently null (first "Generate")
 * or already set ("Regenerate"). */
export async function regenerateInviteCode(leagueId: string, callerUserId: string): Promise<{ inviteCode: string }> {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
    throw new Error("Only the league commissioner can manage the invite link.");
  }
  const inviteCode = randomBytes(9).toString("base64url");
  await prisma.league.update({ where: { id: leagueId }, data: { inviteCode } });
  return { inviteCode };
}

export async function getLeagueByInviteCode(inviteCode: string) {
  return prisma.league.findUnique({ where: { inviteCode }, include: { teams: true } });
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

/** The primary commissioner (see getLeagueCommissioner) plus every team
 * flagged isCoCommissioner. Use this — not the singular version — for any
 * "can this caller act as commissioner" check; the singular one stays for
 * "who founded this league" display purposes only. */
export async function getLeagueCommissioners(leagueId: string): Promise<string[]> {
  const [primary, coCommissioners] = await Promise.all([
    getLeagueCommissioner(leagueId),
    prisma.team.findMany({ where: { leagueId, isCoCommissioner: true }, select: { managerUserId: true } }),
  ]);
  const set = new Set(coCommissioners.map((t) => t.managerUserId));
  if (primary) set.add(primary);
  return [...set];
}

export async function isLeagueCommissioner(leagueId: string, userId: string): Promise<boolean> {
  return (await getLeagueCommissioners(leagueId)).includes(userId);
}

/** Grant/revoke co-commissioner status on a team. Primary-commissioner only
 * — a co-commissioner can't promote peers or lock out the founder. */
export async function setCoCommissioner(input: { leagueId: string; teamId: string; callerUserId: string; isCoCommissioner: boolean }): Promise<void> {
  const primary = await getLeagueCommissioner(input.leagueId);
  if (!primary || primary !== input.callerUserId) {
    throw new Error("Only the primary commissioner can grant or revoke co-commissioner status.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  await prisma.team.update({ where: { id: input.teamId }, data: { isCoCommissioner: input.isCoCommissioner } });
}

export async function deleteLeague(leagueId: string, callerUserId: string): Promise<void> {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
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
  // history would have hit this on delete too. Draft (added with the draft
  // feature) is fixed proactively here instead of waiting to hit it —
  // DraftPick references Draft, so it has to go first.
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
    prisma.draft.deleteMany({ where: { leagueId } }),
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
  // positionMode is ignored here even if the caller's object includes it —
  // see the check below. Only the numeric slot counts are actually editable.
  rosterComposition: RosterComposition;
  draftPickTradingEnabled: boolean;
}

// DESIGN.md §2.10: farm/IR slots, scoring values, and the waiver GP
// threshold are "between seasons, by vote" — real gameplay-affecting
// settings, unlike roster composition/league size/scoring format, which
// stay permanently locked (no edit path exists for those, deliberately —
// that's what makes "locked" true). This app has no real voting system, so
// "by vote" isn't enforced here beyond commissioner-only access; the UI
// says so rather than pretending consent was collected.
export async function updateLeagueSettings(input: UpdateLeagueSettingsInput): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can change league settings.");
  }

  const league = await prisma.league.findUnique({ where: { id: input.leagueId } });
  if (!league) throw new Error("League not found.");
  const current = league.settingsJson as unknown as LeagueSettings;

  if (current.leagueType === "REDRAFT" && input.farmSlots !== 0) {
    throw new Error("Farm slots are always 0 for a REDRAFT league — there's no farm team to size.");
  }

  // positionMode stays locked forever even though the rest of
  // rosterComposition opens up here — same tier as leagueType/scoringFormat.
  if (input.rosterComposition.positionMode !== current.rosterComposition.positionMode) {
    throw new Error("Forward position mode (separate vs. combined) can't be changed after creation.");
  }
  // Re-enforce the creation-time invariant now that the numeric fields are
  // editable too (src/app/leagues/actions.ts's parseRosterComposition does
  // the same check at creation).
  if (input.rosterComposition.positionMode === "SEPARATE" && input.rosterComposition.F !== 0) {
    throw new Error("F must be 0 in separate-positions mode.");
  }
  if (
    input.rosterComposition.positionMode === "COMBINED" &&
    (input.rosterComposition.C !== 0 || input.rosterComposition.LW !== 0 || input.rosterComposition.RW !== 0)
  ) {
    throw new Error("C/LW/RW must be 0 in combined-forwards mode.");
  }

  for (const [key, val] of Object.entries({
    farmSlots: input.farmSlots,
    irSlots: input.irSlots,
    waiverGpThreshold: input.waiverGpThreshold,
    callupsPerWeek: input.callupsPerWeek,
    faabBudget: input.faabBudget,
    faabMinBid: input.faabMinBid,
    rosterC: input.rosterComposition.C,
    rosterLW: input.rosterComposition.LW,
    rosterRW: input.rosterComposition.RW,
    rosterF: input.rosterComposition.F,
    rosterD: input.rosterComposition.D,
    rosterG: input.rosterComposition.G,
    rosterUTIL: input.rosterComposition.UTIL,
    rosterBENCH: input.rosterComposition.BENCH,
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
    rosterComposition: input.rosterComposition,
    draftPickTradingEnabled: input.draftPickTradingEnabled,
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
  for (const key of ["C", "LW", "RW", "F", "D", "G", "UTIL", "BENCH"] as const) {
    trackScalar(`rosterComposition.${key}`, current.rosterComposition[key], next.rosterComposition[key]);
  }
  // draftPickTradingEnabled predates this feature for existing leagues'
  // stored settingsJson — treat a missing value as the true default (on).
  const currentDraftPickTradingEnabled = current.draftPickTradingEnabled !== false;
  if (currentDraftPickTradingEnabled !== next.draftPickTradingEnabled) {
    logs.push({
      leagueId: input.leagueId,
      field: "draftPickTradingEnabled",
      oldValue: currentDraftPickTradingEnabled,
      newValue: next.draftPickTradingEnabled,
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
