"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { dropPlayerFromRoster } from "@/lib/rosters/mutations";

export async function dropPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await dropPlayerFromRoster({ teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}
