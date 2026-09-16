// My Team page's notifications section — unlike the league-wide activity
// feed (src/lib/activity/feed.ts, which only ever shows terminal successes),
// this is scoped to one team and includes things that need this manager's
// attention specifically: trades to act on, your own pending waiver/FAAB
// activity (including losses, which the league feed never shows), and a
// roster state that needs a manual fix (an IR player who's actually cleared).

import { prisma } from "@/lib/db";
import { getTradesForLeague, getTradeDetailById, computeTradeFit } from "@/lib/trades/mutations";

export interface TeamNotification {
  id: string;
  kind:
    | "TRADE_ACTION"
    | "TRADE_PENDING"
    | "TRADE_RESULT"
    | "WAIVER_PENDING"
    | "WAIVER_RESULT"
    | "FAAB_PENDING"
    | "FAAB_RESULT"
    | "ROSTER";
  text: string;
  href: string;
}

const RECENT_RESULT_LIMIT = 10;

// Trade hardening (plans/trades-batch.md Task 1b, gap #4/#6-#9's fallout):
// three terminal-but-unhappy trade outcomes shipped with this pass — a
// half-invalidated trade (INVALIDATED), a trade cancelled after 3 days
// stuck on roster room (AUTO_CANCELLED), and a proposal quietly cancelled
// because another trade on the same player was accepted first (SUPERSEDED).
// None of these were surfaced anywhere before — a manager would just see
// their pending trade vanish with no explanation. Shown to both parties for
// a week (event happened, not "still needs your attention," so it doesn't
// need to live forever like the other notification kinds above).
const TRADE_RESULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRADE_RESULT_EVENTS = ["INVALIDATED", "AUTO_CANCELLED", "SUPERSEDED"] as const;
type TradeResultEvent = (typeof TRADE_RESULT_EVENTS)[number];

const TRADE_RESULT_REASON: Record<TradeResultEvent, (payload: { reason?: string }) => string> = {
  INVALIDATED: (p) => p.reason ?? "an item was no longer available.",
  AUTO_CANCELLED: () => "it stayed stuck on roster room for 3 days.",
  SUPERSEDED: () => "one of the players in it was traded away in another deal.",
};

async function getTradeResultNotifications(leagueId: string, teamId: string): Promise<TeamNotification[]> {
  const since = new Date(Date.now() - TRADE_RESULT_WINDOW_MS);
  const logs = await prisma.transactionLog.findMany({
    where: {
      leagueId,
      type: "TRADE",
      createdAt: { gte: since },
      OR: TRADE_RESULT_EVENTS.map((event) => ({ payload: { path: ["event"], equals: event } })),
    },
    orderBy: { createdAt: "desc" },
  });
  if (logs.length === 0) return [];

  const items: TeamNotification[] = [];
  for (const log of logs) {
    const payload = log.payload as { tradeId?: string; event?: TradeResultEvent; reason?: string };
    if (!payload.tradeId || !payload.event) continue;
    const detail = await getTradeDetailById(payload.tradeId, teamId);
    if (!detail) continue;
    if (detail.proposedByTeamId !== teamId && detail.counterpartyTeamId !== teamId) continue;

    const other = detail.proposedByTeamId === teamId ? detail.counterpartyTeamName : detail.proposedByTeamName;
    items.push({
      id: `trade-result-${log.id}`,
      kind: "TRADE_RESULT",
      text: `Trade with ${other} was cancelled — ${TRADE_RESULT_REASON[payload.event](payload)}`,
      href: `/leagues/${leagueId}/trades`,
    });
  }
  return items;
}

export async function getTeamNotifications(leagueId: string, teamId: string): Promise<TeamNotification[]> {
  const [trades, tradeResults, myClaims, myBids, irSlots] = await Promise.all([
    getTradesForLeague(leagueId, teamId),
    getTradeResultNotifications(leagueId, teamId),
    prisma.waiverClaim.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { player: { select: { fullName: true } } },
    }),
    prisma.faBid.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { player: { select: { fullName: true } } },
    }),
    prisma.rosterSlot.findMany({
      where: { teamId, slotType: "IR", effectiveTo: null },
      include: { player: { select: { fullName: true, officialRosterStatus: true } } },
    }),
  ]);

  const items: TeamNotification[] = [...tradeResults];
  const tradesHref = `/leagues/${leagueId}/trades`;

  for (const t of trades) {
    if (t.state === "PROPOSED" && t.counterpartyTeamId === teamId) {
      items.push({
        id: `trade-action-${t.id}`,
        kind: "TRADE_ACTION",
        text: `Trade from ${t.proposedByTeamName} needs your response`,
        href: `/leagues/${leagueId}/trades/${t.id}/review`,
      });
    } else if (t.state === "PROPOSED" && t.proposedByTeamId === teamId) {
      items.push({
        id: `trade-pending-${t.id}`,
        kind: "TRADE_PENDING",
        text: `Waiting on ${t.counterpartyTeamName} to respond to your trade offer`,
        href: tradesHref,
      });
    } else if (t.state === "UNDER_REVIEW" && (t.proposedByTeamId === teamId || t.counterpartyTeamId === teamId)) {
      const other = t.proposedByTeamId === teamId ? t.counterpartyTeamName : t.proposedByTeamName;
      // Trade integrity (plans/trades-batch.md Task 1) — a trade whose
      // review window has already elapsed but is still UNDER_REVIEW is stuck
      // on a roster-fit conflict (processDueTrades retries it daily rather
      // than failing outright). Name whose fault it is instead of leaving
      // both sides staring at a generic "under review" line forever.
      const otherTeamId = t.proposedByTeamId === teamId ? t.counterpartyTeamId : t.proposedByTeamId;
      const stuck = !!t.reviewEndsAt && t.reviewEndsAt <= new Date();
      const fit = stuck ? await computeTradeFit(leagueId, t.items) : null;
      const myOverflow = fit?.overflow.some((o) => o.teamId === teamId) ?? false;
      const theirOverflow = fit?.overflow.some((o) => o.teamId === otherTeamId) ?? false;

      if (myOverflow) {
        const n = fit!.overflow.filter((o) => o.teamId === teamId).reduce((max, o) => Math.max(max, o.excess), 0);
        items.push({
          id: `trade-review-${t.id}`,
          kind: "TRADE_ACTION",
          text: `Trade with ${other} is waiting on you — drop ${n} player(s) to complete it`,
          href: `/leagues/${leagueId}/teams/${teamId}?dropMode=1&pendingTrade=${t.id}`,
        });
      } else if (theirOverflow) {
        items.push({
          id: `trade-review-${t.id}`,
          kind: "TRADE_PENDING",
          text: `Trade with ${other} is waiting on them to clear roster room`,
          href: tradesHref,
        });
      } else {
        items.push({
          id: `trade-review-${t.id}`,
          kind: "TRADE_PENDING",
          text: `Trade with ${other} is under review${t.reviewEndsAt ? ` until ${t.reviewEndsAt.toISOString().slice(0, 10)}` : ""}`,
          href: tradesHref,
        });
      }
    }
  }

  const pendingClaims = myClaims.filter((c) => c.result === "PENDING");
  for (const c of pendingClaims) {
    items.push({
      id: `claim-pending-${c.id}`,
      kind: "WAIVER_PENDING",
      text: `Waiver claim on ${c.player.fullName} still pending`,
      href: `/leagues/${leagueId}`,
    });
  }
  const resolvedClaims = myClaims.filter((c) => c.result !== "PENDING").slice(0, RECENT_RESULT_LIMIT);
  for (const c of resolvedClaims) {
    items.push({
      id: `claim-result-${c.id}`,
      kind: "WAIVER_RESULT",
      text: c.result === "AWARDED" ? `You won the waiver claim on ${c.player.fullName}` : `Your waiver claim on ${c.player.fullName} didn't win`,
      href: `/leagues/${leagueId}/teams/${teamId}`,
    });
  }

  const pendingBids = myBids.filter((b) => b.result === "PENDING");
  for (const b of pendingBids) {
    items.push({
      id: `bid-pending-${b.id}`,
      kind: "FAAB_PENDING",
      text: `FAAB bid of $${b.amount} on ${b.player.fullName} still pending`,
      href: `/leagues/${leagueId}/players`,
    });
  }
  const resolvedBids = myBids.filter((b) => b.result !== "PENDING").slice(0, RECENT_RESULT_LIMIT);
  for (const b of resolvedBids) {
    items.push({
      id: `bid-result-${b.id}`,
      kind: "FAAB_RESULT",
      text: b.result === "WON" ? `You won the $${b.amount} FAAB bid on ${b.player.fullName}` : `Your FAAB bid on ${b.player.fullName} didn't win`,
      href: `/leagues/${leagueId}/teams/${teamId}`,
    });
  }

  for (const s of irSlots) {
    if (s.player.officialRosterStatus !== "IR") {
      items.push({
        id: `ir-cleared-${s.id}`,
        kind: "ROSTER",
        text: `${s.player.fullName} is no longer officially on IR — move him to Active or Farm`,
        href: `/leagues/${leagueId}/teams/${teamId}`,
      });
    }
  }

  return items;
}
