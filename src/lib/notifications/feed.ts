// My Team page's notifications section — unlike the league-wide activity
// feed (src/lib/activity/feed.ts, which only ever shows terminal successes),
// this is scoped to one team and includes things that need this manager's
// attention specifically: trades to act on, your own pending waiver/FAAB
// activity (including losses, which the league feed never shows), and a
// roster state that needs a manual fix (an IR player who's actually cleared).

import { prisma } from "@/lib/db";
import { getTradesForLeague } from "@/lib/trades/mutations";

export interface TeamNotification {
  id: string;
  kind: "TRADE_ACTION" | "TRADE_PENDING" | "WAIVER_PENDING" | "WAIVER_RESULT" | "FAAB_PENDING" | "FAAB_RESULT" | "ROSTER";
  text: string;
  href: string;
}

const RECENT_RESULT_LIMIT = 2;

export async function getTeamNotifications(leagueId: string, teamId: string): Promise<TeamNotification[]> {
  const [trades, myClaims, myBids, irSlots] = await Promise.all([
    getTradesForLeague(leagueId, teamId),
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

  const items: TeamNotification[] = [];
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
      items.push({
        id: `trade-review-${t.id}`,
        kind: "TRADE_PENDING",
        text: `Trade with ${other} is under review${t.reviewEndsAt ? ` until ${t.reviewEndsAt.toISOString().slice(0, 10)}` : ""}`,
        href: tradesHref,
      });
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
