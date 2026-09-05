"use server";

import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createLeague, deleteLeague, updateLeagueSettings, regenerateInviteCode, type RosterComposition } from "@/lib/leagues/mutations";
import { startNewSeason } from "@/lib/leagues/season";
import { generateSchedule } from "@/lib/matchups/mutations";
import { EDITABLE_SCORING_FIELDS, type ScoringConfig } from "@/lib/scoring/engine";

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

export async function updateLeagueSettingsAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();

  const num = (key: string) => Math.max(0, Number(formData.get(key) ?? 0) | 0);
  const scoringConfig: ScoringConfig = {};
  for (const { key } of EDITABLE_SCORING_FIELDS) {
    scoringConfig[key] = Number(formData.get(`scoring_${key}`) ?? 0);
  }

  const faabMaxBidRaw = String(formData.get("faabMaxBid") ?? "").trim();
  const tradeVetoModeRaw = String(formData.get("tradeVetoMode") ?? "COMMISSIONER");
  const tradeDeadlineRaw = String(formData.get("tradeDeadline") ?? "").trim();

  await updateLeagueSettings({
    leagueId,
    callerUserId: userId,
    farmSlots: num("farmSlots"),
    irSlots: num("irSlots"),
    waiverGpThreshold: num("waiverGpThreshold"),
    callupsPerWeek: num("callupsPerWeek"),
    scoringConfig,
    faabEnabled: formData.get("faabEnabled") === "on",
    faabBudget: num("faabBudget"),
    faabMinBid: num("faabMinBid"),
    faabMaxBid: faabMaxBidRaw === "" ? null : Math.max(0, Number(faabMaxBidRaw) | 0),
    tradeVetoMode: tradeVetoModeRaw === "VOTE" ? "VOTE" : "COMMISSIONER",
    tradeDeadline: tradeDeadlineRaw === "" ? null : tradeDeadlineRaw,
  });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/settings`);
  redirect(`/leagues/${leagueId}/settings?saved=1`);
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
