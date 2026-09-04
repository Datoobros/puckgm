"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import {
  proposeTrade,
  respondToTrade,
  cancelTrade,
  castTradeVeto,
  forceProcessTrade,
  type TradeAssetSelection,
} from "@/lib/trades/mutations";

function readSelection(formData: FormData, prefix: "give" | "receive"): TradeAssetSelection {
  return {
    playerIds: formData.getAll(`${prefix}PlayerIds`).map(String),
    pickIds: formData.getAll(`${prefix}PickIds`).map(String),
    faabAmount: Math.max(0, Number(formData.get(`${prefix}Faab`) ?? 0) | 0),
  };
}

export async function proposeTradeAction(leagueId: string, proposingTeamId: string, formData: FormData) {
  const { userId } = await auth.protect();
  const counterpartyTeamId = String(formData.get("counterpartyTeamId") ?? "");
  await proposeTrade({
    leagueId,
    proposingTeamId,
    counterpartyTeamId,
    managerUserId: userId,
    give: readSelection(formData, "give"),
    receive: readSelection(formData, "receive"),
  });
  revalidatePath(`/leagues/${leagueId}/trades`);
}

export async function respondToTradeAction(leagueId: string, tradeId: string, accept: boolean) {
  const { userId } = await auth.protect();
  await respondToTrade({ tradeId, managerUserId: userId, accept });
  revalidatePath(`/leagues/${leagueId}/trades`);
}

export async function cancelTradeAction(leagueId: string, tradeId: string) {
  const { userId } = await auth.protect();
  await cancelTrade({ tradeId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/trades`);
}

export async function castVetoAction(leagueId: string, tradeId: string) {
  const { userId } = await auth.protect();
  await castTradeVeto({ tradeId, managerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/trades`);
}

export async function forceProcessTradeAction(leagueId: string, tradeId: string) {
  const { userId } = await auth.protect();
  await forceProcessTrade({ tradeId, callerUserId: userId });
  revalidatePath(`/leagues/${leagueId}/trades`);
}
