// The only landing-endpoint consumer left after Task 4b moved roster
// enrichment onto the roster endpoint (see sync.ts) — careerNhlGp drives the
// 80-GP waiver exemption (DESIGN.md §2.3) and isn't in the roster payload,
// so it still needs upsertPlayerFull's per-player landing fetch. Bounded to
// a small nightly batch instead of the old ~950-a-night approach: 40/night
// at REFRESH_CONCURRENCY works through the whole player pool in about three
// weeks, which is ample for a threshold that only matters once, at 80 games
// — nobody needs same-night accuracy on it the way ingest needs same-night
// stats.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { upsertPlayerFull } from "@/lib/players/identity";
import { runWithConcurrency } from "@/lib/concurrency";

const DEFAULT_LIMIT = 40;
// Same rate-limit sensitivity as the old per-player roster sync (both hit
// the landing endpoint) — kept low even though the nightly volume here is
// far smaller, per Task 4b's finding that 6 already tripped the NHL API.
const REFRESH_CONCURRENCY = 3;

export interface CareerGpRefreshResult {
  attempted: number;
  refreshed: number;
  failures: { playerId: number; error: string }[];
}

interface PickedPlayer {
  id: string;
  nhlPlayerId: number;
}

async function pickMore(
  where: Prisma.PlayerWhereInput,
  alreadyPicked: Set<string>,
  remaining: number,
): Promise<PickedPlayer[]> {
  if (remaining <= 0) return [];
  const rows = await prisma.player.findMany({
    where: { ...where, id: { notIn: [...alreadyPicked] } },
    orderBy: { updatedAt: "asc" },
    take: remaining,
    select: { id: true, sourceIds: { where: { source: "nhl" }, select: { sourceId: true } } },
  });
  return rows
    .filter((r) => r.sourceIds.length > 0)
    .map((r) => ({ id: r.id, nhlPlayerId: Number(r.sourceIds[0].sourceId) }));
}

/**
 * Priority order:
 * 1. `careerNhlGp = 0` but with at least one `GameStatLine` — a stub that
 *    got created (or roster-enriched) but never actually reached the
 *    landing endpoint, so its games-played is a placeholder, not a fact.
 * 2. `careerNhlGp` between 60 and 90 — the band where the 80-GP waiver
 *    exemption actually bites, so a stale count there is the highest-stakes
 *    kind of stale.
 * 3. Oldest `updatedAt` first — a plain rolling refresh for everyone else.
 */
export async function refreshCareerGp(limit: number = DEFAULT_LIMIT): Promise<CareerGpRefreshResult> {
  const picked: PickedPlayer[] = [];
  const pickedIds = new Set<string>();

  async function takeMore(where: Prisma.PlayerWhereInput) {
    const more = await pickMore(where, pickedIds, limit - picked.length);
    for (const p of more) {
      picked.push(p);
      pickedIds.add(p.id);
    }
  }

  await takeMore({ careerNhlGp: 0, statLines: { some: {} } });
  await takeMore({ careerNhlGp: { gte: 60, lte: 90 } });
  await takeMore({});

  const failures: { playerId: number; error: string }[] = [];
  let refreshed = 0;

  await runWithConcurrency(picked, REFRESH_CONCURRENCY, async (p) => {
    try {
      await upsertPlayerFull(p.nhlPlayerId);
      refreshed += 1;
    } catch (e) {
      failures.push({ playerId: p.nhlPlayerId, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return { attempted: picked.length, refreshed, failures };
}
