// League home page's "Recent activity" feed — the first thing anywhere in
// this app that reads TransactionLog for display rather than just writing
// to it (or, in one place, counting rows for a weekly limit check). Scoped
// to the events another manager actually wants to see: a waiver claim
// actually being awarded, a FAAB bid actually being won, and a trade
// actually completing — not every routine roster add/drop/callup/lineup
// edit, and not the in-between states (a submitted-but-not-yet-awarded
// claim, a proposed-but-not-yet-accepted trade).

import { prisma } from "@/lib/db";
import { getTradesForLeague } from "@/lib/trades/mutations";

export interface ActivityItem {
  id: string;
  timestamp: Date;
  kind: "WAIVER" | "FAAB" | "TRADE";
  text: string;
}

export async function getRecentActivity(leagueId: string, limit = 20): Promise<ActivityItem[]> {
  const rows = await prisma.transactionLog.findMany({
    where: { leagueId, type: { in: ["WAIVER_CLAIM", "FAAB_WIN", "TRADE"] } },
    orderBy: { createdAt: "desc" },
    take: limit * 3,
  });

  const notable = rows.filter((r) => {
    const payload = r.payload as { event?: string };
    if (r.type === "WAIVER_CLAIM") return payload.event === "AWARDED";
    if (r.type === "TRADE") return payload.event === "PROCESSED" || payload.event === "FORCED";
    return true; // every FAAB_WIN row is already a win
  });
  const trimmed = notable.slice(0, limit);

  const playerIds = new Set<string>();
  const teamIds = new Set<string>();
  const tradeIds = new Set<string>();
  for (const r of trimmed) {
    const payload = r.payload as { playerId?: string; fromTeamId?: string; tradeId?: string; amount?: number };
    if (r.actorTeamId) teamIds.add(r.actorTeamId);
    if (payload.playerId) playerIds.add(payload.playerId);
    if (payload.fromTeamId) teamIds.add(payload.fromTeamId);
    if (r.type === "TRADE" && payload.tradeId) tradeIds.add(payload.tradeId);
  }

  const [players, teams, trades] = await Promise.all([
    playerIds.size > 0
      ? prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, fullName: true } })
      : Promise.resolve([]),
    teamIds.size > 0
      ? prisma.team.findMany({ where: { id: { in: [...teamIds] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    tradeIds.size > 0 ? getTradesForLeague(leagueId, null) : Promise.resolve([]),
  ]);
  const playerName = new Map(players.map((p) => [p.id, p.fullName]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const tradeById = new Map(trades.map((t) => [t.id, t]));

  const items: ActivityItem[] = [];
  for (const r of trimmed) {
    const payload = r.payload as { playerId?: string; fromTeamId?: string; tradeId?: string; amount?: number };
    const actor = (r.actorTeamId && teamName.get(r.actorTeamId)) || "A team";

    if (r.type === "WAIVER_CLAIM") {
      const player = (payload.playerId && playerName.get(payload.playerId)) || "a player";
      const from = (payload.fromTeamId && teamName.get(payload.fromTeamId)) || "another team";
      items.push({
        id: r.id,
        timestamp: r.createdAt,
        kind: "WAIVER",
        text: `${actor} claimed ${player} off waivers from ${from}`,
      });
    } else if (r.type === "FAAB_WIN") {
      const player = (payload.playerId && playerName.get(payload.playerId)) || "a player";
      items.push({
        id: r.id,
        timestamp: r.createdAt,
        kind: "FAAB",
        text: `${actor} won a FAAB bid on ${player}${payload.amount ? ` ($${payload.amount})` : ""}`,
      });
    } else if (r.type === "TRADE" && payload.tradeId) {
      const trade = tradeById.get(payload.tradeId);
      const other = trade
        ? trade.proposedByTeamId === r.actorTeamId
          ? trade.counterpartyTeamName
          : trade.proposedByTeamName
        : "another team";
      items.push({
        id: r.id,
        timestamp: r.createdAt,
        kind: "TRADE",
        text: `${actor} and ${other} completed a trade`,
      });
    }
  }

  return items;
}
