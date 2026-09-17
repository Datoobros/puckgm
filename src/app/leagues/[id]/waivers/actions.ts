"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { submitWaiverClaim, cancelWaiverClaim, setWaiverPriority } from "@/lib/waivers/mutations";

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

export async function setWaiverPriorityAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const orderedTeamIds = formData.getAll("order").map(String);
  await setWaiverPriority({ leagueId, orderedTeamIds, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings/waiver-order`);
  revalidatePath(`/leagues/${leagueId}`);
  redirect(`/leagues/${leagueId}/settings/waiver-order?saved=1`);
}
