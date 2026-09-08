// Watchlist — simple per-user, per-league player tracking. No roster
// mechanics involved; this is purely "players I want to keep an eye on,"
// so there's no cap, no eligibility gate, no transaction log entry.

import { prisma } from "@/lib/db";

export async function getWatchlistedPlayerIds(leagueId: string, userId: string): Promise<Set<string>> {
  const rows = await prisma.watchlistEntry.findMany({
    where: { leagueId, userId },
    select: { playerId: true },
  });
  return new Set(rows.map((r) => r.playerId));
}

export async function toggleWatchlist(leagueId: string, userId: string, playerId: string): Promise<{ watching: boolean }> {
  const existing = await prisma.watchlistEntry.findUnique({
    where: { leagueId_userId_playerId: { leagueId, userId, playerId } },
  });
  if (existing) {
    await prisma.watchlistEntry.delete({ where: { id: existing.id } });
    return { watching: false };
  }
  await prisma.watchlistEntry.create({ data: { leagueId, userId, playerId } });
  return { watching: true };
}
