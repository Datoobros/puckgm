// Shared "who can act on this trade" predicates — factored out of
// trades/page.tsx (which had them inline) so the new settings/trade-review
// page (plans/lm-tools-batch.md Task 5) can't drift from the same rules.
// Pure functions, no DB access — callers already have the trade and the
// viewer's context loaded.

import type { TradeDetail } from "./mutations";

type TradeParticipants = Pick<TradeDetail, "proposedByTeamId" | "counterpartyTeamId">;

export function isTradeParticipant(trade: TradeParticipants, myTeamId: string | null): boolean {
  return !!myTeamId && (trade.proposedByTeamId === myTeamId || trade.counterpartyTeamId === myTeamId);
}

export interface TradeVetoContext {
  tradeVetoMode: "COMMISSIONER" | "VOTE";
  isCommissioner: boolean;
  myTeamId: string | null;
}

/** A commissioner who's a party to the trade can't decide it (same
 * conflict-of-interest exclusion VOTE mode already applies to every other
 * manager). VOTE mode also excludes anyone who's already voted. */
export function canVetoTrade(trade: Pick<TradeDetail, "state" | "hasVetoed"> & TradeParticipants, ctx: TradeVetoContext): boolean {
  if (trade.state !== "UNDER_REVIEW") return false;
  const participant = isTradeParticipant(trade, ctx.myTeamId);
  if (ctx.tradeVetoMode === "COMMISSIONER") return ctx.isCommissioner && !participant;
  return !!ctx.myTeamId && !participant && !trade.hasVetoed;
}

export function canForceProcessTrade(trade: TradeParticipants, ctx: { isCommissioner: boolean; myTeamId: string | null }): boolean {
  return ctx.isCommissioner && !isTradeParticipant(trade, ctx.myTeamId);
}
