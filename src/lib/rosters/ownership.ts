// Split out of src/lib/rosters/mutations.ts specifically to avoid a
// circular import: src/lib/draft/mutations.ts needs these reads, and
// src/lib/rosters/mutations.ts (Task 3, free-agency gate) needs to import
// FROM draft/mutations.ts (assertFreeAgencyOpen). Keeping these on their own
// file, depended on by both, mirrors the same fix already used for
// src/lib/leagues/season.ts (see that file's header comment).
// activeRosterCap joined this file for the same reason (draft-fix-batch
// Task 1) — draft/mutations.ts needs it for cap-aware pick recording and
// round-count validation.

import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";

/** playerId -> owning team name, scoped to one league. Used by the players
 * page to show ownership status instead of letting an Add click fail, and
 * by the draft pool to exclude anyone already rostered. */
export async function getLeagueOwnershipMap(
  leagueId: string,
  playerIds: string[],
): Promise<Map<string, string>> {
  if (playerIds.length === 0) return new Map();
  const slots = await prisma.rosterSlot.findMany({
    where: {
      playerId: { in: playerIds },
      effectiveTo: null,
      team: { leagueId },
    },
    include: { team: true },
  });
  return new Map(slots.map((s) => [s.playerId, s.team.name]));
}

export function activeRosterCap(settings: LeagueSettings): number {
  // Object.values would also pick up positionMode ("SEPARATE"/"COMBINED"), a
  // string, not a slot count — exclude it explicitly rather than summing
  // every value blindly.
  const { positionMode: _positionMode, ...counts } = settings.rosterComposition;
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}
