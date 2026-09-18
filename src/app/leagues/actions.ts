"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import {
  createLeague,
  deleteLeague,
  updateLeagueSettings,
  regenerateInviteCode,
  getLeague,
  getLeagueCommissioner,
  setCoCommissioner,
  isLeagueCommissioner,
  renameTeam,
  addTeamAsCommissioner,
  setTeamManager,
  regenerateTeamClaimCode,
  deleteTeam,
  setTeamDivision,
  getLeagueDivisions,
  setLeagueDivisions,
  renameLeagueDivision,
  type RosterComposition,
  type LeagueSettings,
  type UpdateLeagueSettingsInput,
} from "@/lib/leagues/mutations";
import { startNewSeason } from "@/lib/leagues/season";
import { inviteManagerByEmail, inviteToLeagueByEmail } from "@/lib/leagues/invitations";
import { generateSchedule, resetSchedule } from "@/lib/matchups/mutations";
import { EDITABLE_SCORING_FIELDS, type ScoringConfig } from "@/lib/scoring/engine";
import { cancelTrade } from "@/lib/trades/mutations";

function parseRosterComposition(formData: FormData): RosterComposition {
  const num = (key: string) => Math.max(0, Number(formData.get(key) ?? 0) | 0);
  const positionMode = String(formData.get("positionMode") ?? "SEPARATE") === "COMBINED" ? "COMBINED" : "SEPARATE";
  return {
    positionMode,
    C: positionMode === "SEPARATE" ? num("posC") : 0,
    LW: positionMode === "SEPARATE" ? num("posLW") : 0,
    RW: positionMode === "SEPARATE" ? num("posRW") : 0,
    F: positionMode === "COMBINED" ? num("posF") : 0,
    D: num("posD"),
    G: num("posG"),
    UTIL: num("posUTIL"),
    BENCH: num("posBENCH"),
  };
}

export async function createLeagueAction(formData: FormData) {
  // Verified again here even though the page is already auth.protect()'d —
  // Server Actions are their own entry point and must not trust the caller.
  const { userId } = await auth.protect();

  const name = String(formData.get("name") ?? "").trim();
  const teamName = String(formData.get("teamName") ?? "").trim();
  const season = Number(formData.get("season") ?? 0);
  const leagueType = String(formData.get("leagueType") ?? "DYNASTY") === "REDRAFT" ? "REDRAFT" : "DYNASTY";
  if (!name || !teamName || !season) {
    throw new Error("League name, team name, and season are required.");
  }

  const { leagueId } = await createLeague({
    name,
    season,
    managerUserId: userId,
    teamName,
    leagueType,
    rosterComposition: parseRosterComposition(formData),
    farmSlots: Math.max(0, Number(formData.get("farmSlots") ?? 6) | 0),
    irSlots: Math.max(0, Number(formData.get("irSlots") ?? 2) | 0),
  });

  redirect(`/leagues/${leagueId}`);
}

export async function deleteLeagueAction(leagueId: string) {
  const { userId } = await auth.protect();
  await deleteLeague(leagueId, userId);
  redirect("/leagues");
}

export async function generateScheduleAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();

  const season = Number(formData.get("season") ?? 0);
  const startDate = String(formData.get("startDate") ?? "");
  const weekCount = Number(formData.get("weekCount") ?? 0);
  const playoffTeams = Number(formData.get("playoffTeams") ?? 0);
  if (!season || !startDate || !weekCount) {
    throw new Error("Season, start date, and week count are required.");
  }

  await generateSchedule({ leagueId, season, startDate, weekCount, playoffTeams, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/standings`);
  revalidatePath(`/leagues/${leagueId}/scoreboard`);
}

// Maps the league's current stored settings onto updateLeagueSettings's full
// input shape — each partial-update action below spreads this and overrides
// only the fields its own form actually edits. updateLeagueSettings itself
// stays a full-input call (its validation and LeagueSettingsLog diffing
// already work correctly against a full object); this is what lets three
// separate small forms share it without each having to resend every field.
export async function currentSettingsInput(leagueId: string, callerUserId: string): Promise<UpdateLeagueSettingsInput> {
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const s = league.settingsJson as unknown as LeagueSettings;
  return {
    leagueId,
    callerUserId,
    farmSlots: s.farmSlots,
    irSlots: s.irSlots,
    waiverGpThreshold: s.waiverGpThreshold,
    callupsPerWeek: s.callupsPerWeek,
    scoringConfig: s.scoringConfig,
    faabEnabled: s.faabEnabled,
    faabBudget: s.faabBudget,
    faabMinBid: s.faabMinBid,
    faabMaxBid: s.faabMaxBid,
    tradeVetoMode: s.tradeVetoMode,
    tradeDeadline: s.tradeDeadline,
    rosterComposition: s.rosterComposition,
    draftPickTradingEnabled: s.draftPickTradingEnabled !== false,
  };
}

export async function updateLeagueGeneralSettingsAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const base = await currentSettingsInput(leagueId, userId);
  const num = (key: string) => Math.max(0, Number(formData.get(key) ?? 0) | 0);
  const faabMaxBidRaw = String(formData.get("faabMaxBid") ?? "").trim();
  const tradeVetoModeRaw = String(formData.get("tradeVetoMode") ?? "COMMISSIONER");
  const tradeDeadlineRaw = String(formData.get("tradeDeadline") ?? "").trim();

  await updateLeagueSettings({
    ...base,
    faabEnabled: formData.get("faabEnabled") === "on",
    faabBudget: num("faabBudget"),
    faabMinBid: num("faabMinBid"),
    faabMaxBid: faabMaxBidRaw === "" ? null : Math.max(0, Number(faabMaxBidRaw) | 0),
    tradeVetoMode: tradeVetoModeRaw === "VOTE" ? "VOTE" : "COMMISSIONER",
    tradeDeadline: tradeDeadlineRaw === "" ? null : tradeDeadlineRaw,
    draftPickTradingEnabled: formData.get("draftPickTradingEnabled") === "on",
  });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings/league`);
  redirect(`/leagues/${leagueId}/settings/league?saved=1`);
}

export async function updateScoringSettingsAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const base = await currentSettingsInput(leagueId, userId);
  const scoringConfig: ScoringConfig = {};
  for (const { key } of EDITABLE_SCORING_FIELDS) {
    scoringConfig[key] = Number(formData.get(`scoring_${key}`) ?? 0);
  }

  await updateLeagueSettings({ ...base, scoringConfig });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings/scoring`);
  redirect(`/leagues/${leagueId}/settings/scoring?saved=1`);
}

export async function updateRosterSettingsAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const base = await currentSettingsInput(leagueId, userId);
  const num = (key: string) => Math.max(0, Number(formData.get(key) ?? 0) | 0);
  // positionMode is never read from the form — it's locked forever, so it's
  // always taken from the league's current settings, not the caller.
  const positionMode = base.rosterComposition.positionMode;

  await updateLeagueSettings({
    ...base,
    farmSlots: num("farmSlots"),
    irSlots: num("irSlots"),
    waiverGpThreshold: num("waiverGpThreshold"),
    callupsPerWeek: num("callupsPerWeek"),
    rosterComposition: {
      positionMode,
      C: positionMode === "SEPARATE" ? num("rosterC") : 0,
      LW: positionMode === "SEPARATE" ? num("rosterLW") : 0,
      RW: positionMode === "SEPARATE" ? num("rosterRW") : 0,
      F: positionMode === "COMBINED" ? num("rosterF") : 0,
      D: num("rosterD"),
      G: num("rosterG"),
      UTIL: num("rosterUTIL"),
      BENCH: num("rosterBENCH"),
    },
  });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings/roster-settings`);
  redirect(`/leagues/${leagueId}/settings/roster-settings?saved=1`);
}

export async function startNewSeasonAction(leagueId: string) {
  const { userId } = await auth.protect();
  await startNewSeason(leagueId, userId);
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/teams`);
}

export async function regenerateInviteCodeAction(leagueId: string) {
  const { userId } = await auth.protect();
  await regenerateInviteCode(leagueId, userId);
  revalidatePath(`/leagues/${leagueId}/settings`);
}

export async function setCoCommissionerAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  await setCoCommissioner({ leagueId, teamId, callerUserId: userId, isCoCommissioner: formData.get("isCoCommissioner") === "on" });
  revalidatePath(`/leagues/${leagueId}/settings`);
}

// Batch version for settings/powers/page.tsx — one Save button for every
// team's checkbox at once. Checked here explicitly (not just left to
// setCoCommissioner's own per-row check) so a caller with zero changed rows
// still gets refused outright, rather than silently "succeeding" with no
// writes and no error.
export async function setCoCommissionersAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const primary = await getLeagueCommissioner(leagueId);
  if (!primary || primary !== userId) {
    throw new Error("Only the primary commissioner can change LM powers.");
  }
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  for (const team of league.teams) {
    const next = formData.get(`cocomm_${team.id}`) === "on";
    if (next !== team.isCoCommissioner) {
      await setCoCommissioner({ leagueId, teamId: team.id, callerUserId: userId, isCoCommissioner: next });
    }
  }
  revalidatePath(`/leagues/${leagueId}/settings/powers`);
  redirect(`/leagues/${leagueId}/settings/powers?saved=1`);
}

export async function renameTeamAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const name = String(formData.get("name") ?? "");
  await renameTeam({ leagueId, teamId, callerUserId: userId, name });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/teams`);
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function addTeamAsCommissionerAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const teamName = String(formData.get("teamName") ?? "");
  await addTeamAsCommissioner({ leagueId, callerUserId: userId, teamName });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/teams`);
}

export async function reassignTeamManagerAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const newManagerUserId = String(formData.get("newManagerUserId") ?? "").trim();
  await setTeamManager({ leagueId, teamId, callerUserId: userId, newManagerUserId });
  revalidatePath(`/leagues/${leagueId}/settings`);
}

export async function orphanTeamAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  // Checked here too (setTeamManager below re-checks it independently) so a
  // non-commissioner caller fails on the same "only the commissioner" error
  // it always has, rather than surfacing cancelTrade's unrelated "you aren't
  // part of this trade" if this team happens to have one in flight.
  if (!(await isLeagueCommissioner(leagueId, userId))) {
    throw new Error("Only the league commissioner can reassign a team's manager.");
  }
  // Trade hardening (plans/trades-batch.md Task 1b, gap #9): orphaning used
  // to leave a team's in-flight trades alive — they'd still process onto or
  // off a now-frozen roster. Cancel every PROPOSED/UNDER_REVIEW trade this
  // team is party to first, then orphan — same "cancel in-flight trades
  // before the state change" shape src/lib/leagues/season.ts's
  // startNewSeason already uses for a full-league roster wipe. Done here at
  // the action layer, not inside setTeamManager/leagues/mutations.ts itself:
  // trades/mutations.ts already imports from leagues/mutations.ts, so
  // importing cancelTrade back in there would create the same
  // circular-import shape already avoided elsewhere in this app.
  const inFlightTrades = await prisma.trade.findMany({
    where: {
      leagueId,
      state: { in: ["PROPOSED", "UNDER_REVIEW"] },
      items: { some: { OR: [{ fromTeamId: teamId }, { toTeamId: teamId }] } },
    },
    select: { id: true },
  });
  for (const trade of inFlightTrades) {
    await cancelTrade({ tradeId: trade.id, callerUserId: userId, allowUnderReview: true });
  }
  await setTeamManager({ leagueId, teamId, callerUserId: userId, orphan: true });
  revalidatePath(`/leagues/${leagueId}/settings`);
}

export async function regenerateTeamClaimCodeAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  await regenerateTeamClaimCode({ leagueId, teamId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings`);
}

// Read server-side rather than trusting a client-supplied origin — this
// value goes straight into an email's redirect link, matching how the
// Managers page itself already computes the invite-link origin.
async function currentOrigin(): Promise<string> {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
}

export async function inviteManagerByEmailAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const email = String(formData.get("email") ?? "");
  await inviteManagerByEmail({ leagueId, teamId, email, origin: await currentOrigin(), callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings/managers`);
}

export async function inviteToLeagueByEmailAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const email = String(formData.get("email") ?? "");
  await inviteToLeagueByEmail({ leagueId, email, origin: await currentOrigin(), callerUserId: userId });
  redirect(`/leagues/${leagueId}/settings/managers?invited=1`);
}

export async function deleteTeamAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  await deleteTeam({ leagueId, teamId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/teams`);
}

export async function setTeamDivisionAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const division = String(formData.get("division") ?? "");
  await setTeamDivision({ leagueId, teamId, callerUserId: userId, division });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/standings`);
}

// Save-all for settings/teams-divisions/page.tsx — one submit renaming and/or
// re-dividing every team whose row actually changed, instead of one form per
// field per team.
export async function saveTeamsAndDivisionsAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  for (const team of league.teams) {
    const name = String(formData.get(`name_${team.id}`) ?? "").trim();
    if (name && name !== team.name) {
      await renameTeam({ leagueId, teamId: team.id, callerUserId: userId, name });
    }
    const divisionRaw = String(formData.get(`division_${team.id}`) ?? "").trim();
    if (divisionRaw !== (team.division ?? "")) {
      await setTeamDivision({ leagueId, teamId: team.id, callerUserId: userId, division: divisionRaw });
    }
  }
  revalidatePath(`/leagues/${leagueId}/settings/teams-divisions`);
  revalidatePath(`/leagues/${leagueId}/standings`);
  redirect(`/leagues/${leagueId}/settings/teams-divisions?saved=1`);
}

// Divisions section of settings/teams-divisions/page.tsx (LM Tools Task 6).
// "Add" and "Remove" both go through setLeagueDivisions (full-list
// replacement) — Remove is just resubmitting the list without that name.
// Rename gets its own dedicated action so teams move with the name instead
// of being cleared, which a bare list diff can't distinguish from a removal.
export async function addDivisionAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const newDivision = String(formData.get("newDivision") ?? "").trim();
  if (!newDivision) throw new Error("Division name is required.");
  const current = await getLeagueDivisions(leagueId);
  await setLeagueDivisions({ leagueId, callerUserId: userId, divisions: [...current, newDivision] });
  revalidatePath(`/leagues/${leagueId}/settings/teams-divisions`);
  revalidatePath(`/leagues/${leagueId}/standings`);
}

export async function removeDivisionAction(leagueId: string, division: string) {
  const { userId } = await auth.protect();
  const current = await getLeagueDivisions(leagueId);
  await setLeagueDivisions({ leagueId, callerUserId: userId, divisions: current.filter((d) => d !== division) });
  revalidatePath(`/leagues/${leagueId}/settings/teams-divisions`);
  revalidatePath(`/leagues/${leagueId}/standings`);
}

export async function renameDivisionAction(leagueId: string, from: string, formData: FormData) {
  const { userId } = await auth.protect();
  const to = String(formData.get("name") ?? "").trim();
  await renameLeagueDivision({ leagueId, callerUserId: userId, from, to });
  revalidatePath(`/leagues/${leagueId}/settings/teams-divisions`);
  revalidatePath(`/leagues/${leagueId}/standings`);
}

export async function resetScheduleAction(leagueId: string, season: number) {
  const { userId } = await auth.protect();
  await resetSchedule(leagueId, userId, season);
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/standings`);
  revalidatePath(`/leagues/${leagueId}/scoreboard`);
}
