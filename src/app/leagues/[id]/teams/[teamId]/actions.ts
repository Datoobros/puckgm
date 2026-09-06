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
import { regenerateCoManagerClaimCode, removeCoManager, setTeamLogo } from "@/lib/leagues/mutations";
import { put } from "@vercel/blob";

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

export async function regenerateCoManagerClaimCodeAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  await regenerateCoManagerClaimCode({ leagueId, teamId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function removeCoManagerAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  await removeCoManager({ leagueId, teamId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

const MAX_LOGO_UPLOAD_BYTES = 300_000; // client resizes to ~200px first; this just bounds a misbehaving client

export async function setTeamLogoAction(leagueId: string, teamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const dataUrl = String(formData.get("logoDataUrl") ?? "");
  if (!dataUrl.startsWith("data:image/")) throw new Error("No image was provided.");
  if (dataUrl.length > MAX_LOGO_UPLOAD_BYTES) throw new Error("Image is too large.");

  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = blob.type.split("/")[1] ?? "png";
  const { url } = await put(`team-logos/${teamId}-${Date.now()}.${ext}`, blob, { access: "public" });

  await setTeamLogo({ leagueId, teamId, callerUserId: userId, logoUrl: url });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}

export async function removeTeamLogoAction(leagueId: string, teamId: string) {
  const { userId } = await auth.protect();
  await setTeamLogo({ leagueId, teamId, callerUserId: userId, logoUrl: null });
  revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
}
