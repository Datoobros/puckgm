"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import {
  dropPlayerFromRoster,
  sendToFarm,
  callUpToActive,
  placeOnIR,
  activateFromIR,
  commissionerAddPlayer,
  commissionerDropPlayer,
  commissionerMovePlayer,
} from "@/lib/rosters/mutations";
import { setLineupSlot, autoSetLineup } from "@/lib/lineups/mutations";

export async function dropPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await dropPlayerFromRoster({ teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function sendToFarmAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await sendToFarm({ leagueId, teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function callUpAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await callUpToActive({ leagueId, teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function placeOnIrAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await placeOnIR({ leagueId, teamId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function activateFromIrAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await activateFromIR({ leagueId, teamId, playerId, managerUserId: userId });
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

// Commissioner-only direct roster overrides — full bypass, distinct from
// the manager-facing actions above (src/lib/rosters/mutations.ts).
export async function commissionerAddPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await commissionerAddPlayer({ leagueId, teamId, playerId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function commissionerDropPlayerAction(leagueId: string, teamId: string, playerId: string) {
  const { userId } = await auth.protect();
  await commissionerDropPlayer({ leagueId, teamId, playerId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function commissionerMovePlayerAction(leagueId: string, teamId: string, playerId: string, targetSlotType: "ACTIVE" | "FARM" | "IR") {
  const { userId } = await auth.protect();
  await commissionerMovePlayer({ leagueId, teamId, playerId, targetSlotType, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}
