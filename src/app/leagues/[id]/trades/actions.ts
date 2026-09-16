"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  proposeTrade,
  respondToTrade,
  cancelTrade,
  castTradeVeto,
  forceProcessTrade,
  buildProposalItems,
  computeTradeFit,
  type TradeAssetSelection,
  type TradeFit,
} from "@/lib/trades/mutations";

// Called imperatively from TradeBuilder.tsx (not a <form action>), and
// deliberately catches rather than throws: a Server Action invoked directly
// from an event handler has its thrown error redacted in production (only a
// generic digest reaches the client), which would swallow proposeTrade's
// specific validation messages (locked player, roster overflow, deadline,
// draft in progress, …) that the confirm modal needs to show verbatim.
// Returning a plain value instead sidesteps that entirely. On success, the
// caller does router.push(redirectTo) itself — redirect() can't be called
// from a client event handler (see next/navigation's redirect docs), only
// during render or a <form action> submission.
export async function proposeTradeAction(
  leagueId: string,
  proposingTeamId: string,
  counterpartyTeamId: string,
  give: TradeAssetSelection,
  receive: TradeAssetSelection,
): Promise<{ ok: true; redirectTo: string } | { ok: false; error: string }> {
  const { userId } = await auth.protect();
  try {
    await proposeTrade({
      leagueId,
      proposingTeamId,
      counterpartyTeamId,
      managerUserId: userId,
      give,
      receive,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send trade proposal." };
  }
  revalidatePath(`/leagues/${leagueId}/trades`);
  revalidatePath(`/leagues/${leagueId}/teams/${proposingTeamId}`);
  revalidatePath(`/leagues/${leagueId}/teams/${counterpartyTeamId}`);
  return { ok: true, redirectTo: `/leagues/${leagueId}/teams/${proposingTeamId}?sent=${counterpartyTeamId}` };
}

// Trades batch Task 3 (roster-fit UX) — a pure read, called imperatively from
// TradeBuilder.tsx's Continue button before opening either modal. Reuses
// buildProposalItems + computeTradeFit (Task 1) so the pre-flight check and
// proposeTrade's real server-side guard can never drift apart into two
// different fit calculations.
export async function checkTradeFitAction(
  leagueId: string,
  proposingTeamId: string,
  counterpartyTeamId: string,
  give: TradeAssetSelection,
  receive: TradeAssetSelection,
): Promise<TradeFit> {
  await auth.protect();
  const items = buildProposalItems({ proposingTeamId, counterpartyTeamId, give, receive });
  return computeTradeFit(leagueId, items);
}

export async function respondToTradeAction(leagueId: string, tradeId: string, accept: boolean) {
  const { userId } = await auth.protect();
  await respondToTrade({ tradeId, managerUserId: userId, accept });
  revalidatePath(`/leagues/${leagueId}/trades`);
  redirect(`/leagues/${leagueId}/trades`);
}

/** Simplest possible "counter" — decline the original, then send the user
 * back to the builder pre-filled with the same two teams/assets (swapped),
 * fully editable before it's sent as a brand-new, unlinked trade. No
 * "countered" relationship in the data model. */
export async function counterTradeAction(leagueId: string, tradeId: string) {
  const { userId } = await auth.protect();
  await respondToTrade({ tradeId, managerUserId: userId, accept: false });
  revalidatePath(`/leagues/${leagueId}/trades`);
  redirect(`/leagues/${leagueId}/trades/new?counterFrom=${tradeId}`);
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
