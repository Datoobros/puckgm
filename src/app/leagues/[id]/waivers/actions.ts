"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { submitWaiverClaim, cancelWaiverClaim } from "@/lib/waivers/mutations";

export async function submitWaiverClaimAction(leagueId: string, playerId: string) {
  const { userId } = await auth.protect();
  await submitWaiverClaim({ leagueId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/waivers`);
}

export async function cancelWaiverClaimAction(leagueId: string, claimId: string) {
  const { userId } = await auth.protect();
  await cancelWaiverClaim({ claimId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/waivers`);
}
