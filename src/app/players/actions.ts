"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { addPlayerToRoster } from "@/lib/rosters/mutations";

export async function addPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await addPlayerToRoster({ leagueId, teamId, playerId, managerUserId: userId });
  revalidatePath("/players");
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}
