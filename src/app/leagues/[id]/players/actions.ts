"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { addPlayerToRoster } from "@/lib/rosters/mutations";
import { submitFaBid, cancelFaBid } from "@/lib/faab/mutations";

export async function addPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await addPlayerToRoster({ leagueId, teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/players`);
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function submitFaBidAction(leagueId: string, playerId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const amount = Math.max(0, Number(formData.get("amount") ?? 0) | 0);
  const targetSlot = formData.get("targetSlot") === "FARM" ? "FARM" : "ACTIVE";
  await submitFaBid({ leagueId, playerId, amount, targetSlot, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/players`);
}

export async function cancelFaBidAction(leagueId: string, bidId: string) {
  const { userId } = await auth.protect();
  await cancelFaBid({ bidId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/players`);
}
