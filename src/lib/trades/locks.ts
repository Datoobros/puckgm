// Trade-lock check (plans/trades-batch.md Task 1, issues #4/#5). A leaf
// module on purpose: trades/mutations.ts imports from rosters/mutations.ts
// (activeRosterCap), and the lock check has to run *inside*
// rosters/mutations.ts (drop/farm/IR/callup) and waivers/mutations.ts
// (submitWaiverClaim) — if this lived in trades/mutations.ts instead, those
// two files importing it would create a circular import with
// trades/mutations.ts importing back from rosters/mutations.ts. Importing
// only @/lib/db here keeps rosters/, waivers/, and trades/mutations.ts free
// to all import from this file with nothing importing back.

import { prisma } from "@/lib/db";

/** playerId -> tradeId for every player locked by an UNDER_REVIEW trade in
 * this league; `playerIds` narrows the query when given (pass the specific
 * players a caller cares about rather than scanning the whole league). */
export async function getTradeLockedPlayerIds(leagueId: string, playerIds?: string[]): Promise<Map<string, string>> {
  const items = await prisma.tradeItem.findMany({
    where: {
      itemType: "PLAYER",
      ...(playerIds ? { playerId: { in: playerIds } } : {}),
      trade: { leagueId, state: "UNDER_REVIEW" },
    },
    include: { player: { select: { fullName: true } } },
  });

  const locked = new Map<string, string>();
  for (const item of items) {
    if (item.playerId) locked.set(item.playerId, item.tradeId);
  }
  return locked;
}

/** Throws naming the first locked player found, e.g. "Connor McDavid is
 * locked in a pending trade and can't be dropped until it processes." —
 * called before any write in every roster-mutating path a locked player
 * could otherwise slip through (drop/farm/callup/IR, a new trade proposal,
 * a waiver claim). Lineup slot changes are deliberately NOT gated by this —
 * a locked player still plays for his current owner until the trade
 * actually processes. */
export async function assertPlayersNotTradeLocked(leagueId: string, playerIds: string[], what: string): Promise<void> {
  if (playerIds.length === 0) return;

  const items = await prisma.tradeItem.findMany({
    where: { itemType: "PLAYER", playerId: { in: playerIds }, trade: { leagueId, state: "UNDER_REVIEW" } },
    include: { player: { select: { fullName: true } } },
  });
  const first = items[0];
  if (first) {
    throw new Error(`${first.player!.fullName} is locked in a pending trade and can't be ${what} until it processes.`);
  }
}
