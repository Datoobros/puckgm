"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import {
  setUpDraft,
  startDraft,
  resolveDraftState,
  makeDraftPick,
  updateDraftSetup,
  cancelDraftSetup,
  resetDraftPickOwnership,
  type DraftStateView,
} from "@/lib/draft/mutations";

export async function setUpDraftAction(leagueId: string, formData: FormData) {
  const { userId } = await auth.protect();

  const type = String(formData.get("type") ?? "STARTUP") === "ROOKIE" ? "ROOKIE" : "STARTUP";
  const season = Number(formData.get("season") ?? 0);
  const roundCount = Number(formData.get("roundCount") ?? 0);
  const orderMode = String(formData.get("orderMode") ?? "RANDOM") === "MANUAL" ? "MANUAL" : "RANDOM";
  const pickTimerSeconds = Number(formData.get("pickTimerSeconds") ?? 90);
  const manualOrder = formData.getAll("manualOrder").map(String).filter(Boolean);

  await setUpDraft({
    leagueId,
    season,
    type,
    roundCount,
    orderMode,
    manualOrder: orderMode === "MANUAL" ? manualOrder : undefined,
    pickTimerSeconds,
    callerUserId: userId,
  });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/draft`);
}

export async function startDraftAction(leagueId: string, draftId: string) {
  const { userId } = await auth.protect();
  await startDraft({ draftId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/draft`);
}

export async function resolveDraftStateAction(draftId: string): Promise<DraftStateView> {
  await auth.protect();
  return resolveDraftState(draftId);
}

export async function makeDraftPickAction(leagueId: string, draftId: string, playerId: string): Promise<DraftStateView> {
  const { userId } = await auth.protect();
  await makeDraftPick({ draftId, playerId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/draft`);
  return resolveDraftState(draftId);
}

export async function updateDraftSetupAction(leagueId: string, draftId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const roundCountRaw = String(formData.get("roundCount") ?? "").trim();
  const pickTimerSecondsRaw = String(formData.get("pickTimerSeconds") ?? "").trim();
  const orderModeRaw = String(formData.get("orderMode") ?? "").trim();
  const manualOrder = formData.getAll("manualOrder").map(String).filter(Boolean);

  await updateDraftSetup({
    draftId,
    callerUserId: userId,
    roundCount: roundCountRaw ? Number(roundCountRaw) : undefined,
    pickTimerSeconds: pickTimerSecondsRaw ? Number(pickTimerSecondsRaw) : undefined,
    orderMode: orderModeRaw === "RANDOM" || orderModeRaw === "MANUAL" ? orderModeRaw : undefined,
    manualOrder: orderModeRaw === "MANUAL" ? manualOrder : undefined,
  });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/draft`);
}

export async function cancelDraftSetupAction(leagueId: string, draftId: string) {
  const { userId } = await auth.protect();
  await cancelDraftSetup({ draftId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/draft`);
}

export async function resetDraftPickOwnershipAction(leagueId: string) {
  const { userId } = await auth.protect();
  await resetDraftPickOwnership(leagueId, userId);
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/trades`);
}
