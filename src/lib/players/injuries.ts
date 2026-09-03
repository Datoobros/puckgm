// Recomputes Player.officialRosterStatus from ESPN's injuries feed every
// run — not hand-maintained, same philosophy as careerNhlGp/currentNhlOrg.
// Only ESPN's exact "Injured Reserve" status is trusted as real IR
// (DESIGN.md §2.6); anyone not in that list this run gets cleared back to
// ACTIVE, including someone who was IR last run and has since cleared.
//
// LTIR isn't distinguished from regular IR here — ESPN's feed doesn't
// carry that distinction, so inventing one would be exactly the kind of
// unreliable-data-as-load-bearing-rule this app avoids. Everything ESPN
// calls "Injured Reserve" becomes our "IR".

import { prisma } from "@/lib/db";
import { getEspnInjuries } from "@/lib/nhl/espn";

export interface InjurySyncResult {
  matched: number;
  cleared: number;
  unmatched: { name: string; team: string | null }[];
}

export async function syncInjuryStatuses(): Promise<InjurySyncResult> {
  const injuries = await getEspnInjuries();
  const irEntries = injuries.filter((e) => e.status === "Injured Reserve");

  const matchedPlayerIds: string[] = [];
  const unmatched: { name: string; team: string | null }[] = [];

  for (const entry of irEntries) {
    const candidates = await prisma.player.findMany({
      where: { fullName: entry.athleteName, ...(entry.teamAbbrev ? { currentNhlOrg: entry.teamAbbrev } : {}) },
    });
    if (candidates.length !== 1) {
      unmatched.push({ name: entry.athleteName, team: entry.teamAbbrev });
      continue;
    }
    matchedPlayerIds.push(candidates[0].id);
  }

  const uniqueMatched = [...new Set(matchedPlayerIds)];

  const [{ count: setCount }, { count: clearedCount }] = await prisma.$transaction([
    prisma.player.updateMany({
      where: { id: { in: uniqueMatched } },
      data: { officialRosterStatus: "IR" },
    }),
    prisma.player.updateMany({
      where: { officialRosterStatus: "IR", id: { notIn: uniqueMatched } },
      data: { officialRosterStatus: null },
    }),
  ]);

  return { matched: setCount, cleared: clearedCount, unmatched };
}
