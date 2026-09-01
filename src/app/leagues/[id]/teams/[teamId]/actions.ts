"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { dropPlayerFromRoster } from "@/lib/rosters/mutations";
import { setLineupSlot, autoSetLineup } from "@/lib/lineups/mutations";

export async function dropPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await dropPlayerFromRoster({ teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function setLineupSlotAction(
  leagueId: string,
  teamId: string,
  playerId: string,
  date: string,
  formData: FormData,
) {
  const { userId } = await auth.protect();
  const slot = String(formData.get("slot"));
  await setLineupSlot({ leagueId, teamId, playerId, date, slot, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function autoSetLineupAction(leagueId: string, teamId: string, dates: string[]) {
  const { userId } = await auth.protect();
  await autoSetLineup({ leagueId, teamId, dates, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}
