"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { createLeague, createTeam, deleteLeague, type RosterComposition } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";

function parseRosterComposition(formData: FormData): RosterComposition {
  const num = (key: string) => Math.max(0, Number(formData.get(key) ?? 0) | 0);
  return {
    C: num("posC"),
    LW: num("posLW"),
    RW: num("posRW"),
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
  if (!name || !teamName || !season) {
    throw new Error("League name, team name, and season are required.");
  }

  const { leagueId } = await createLeague({
    name,
    season,
    managerUserId: userId,
    teamName,
    rosterComposition: parseRosterComposition(formData),
    farmSlots: Math.max(0, Number(formData.get("farmSlots") ?? 6) | 0),
    irSlots: Math.max(0, Number(formData.get("irSlots") ?? 2) | 0),
  });

  redirect(`/leagues/${leagueId}`);
}

export async function createTeamAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();

  const teamName = String(formData.get("teamName") ?? "").trim();
  if (!teamName) {
    throw new Error("Team name is required.");
  }

  await createTeam({ leagueId, managerUserId: userId, teamName });
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
  if (!season || !startDate || !weekCount) {
    throw new Error("Season, start date, and week count are required.");
  }

  await generateSchedule({ leagueId, season, startDate, weekCount, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}`);
  revalidatePath(`/leagues/${leagueId}/standings`);
  revalidatePath(`/leagues/${leagueId}/scoreboard`);
}
