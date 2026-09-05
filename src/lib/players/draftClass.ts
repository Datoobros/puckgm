// Ingests a real NHL Entry Draft class as name/org/position-only Player
// stubs — no real NHL player ID exists yet for a pre-NHL prospect, so these
// are keyed by a synthetic PlayerSourceId instead (source "nhl-draft",
// sourceId "${year}-${overallPick}"), which is what makes re-running the
// same year idempotent. currentNhlOrg is set to the *drafting* team, which
// is what makes these players "tied to an NHL organization" per DESIGN.md
// §2.1's draftable-pool rule even though they haven't played a game — no
// season stats exist for them, by design (see PROGRESS.md's Draft section).
//
// This is a manual, once-a-year, run-after-the-real-draft admin action
// (scripts/ingest-draft-class.ts) — the real NHL draft happens once a year
// in June, so there's nothing for a daily cron to check. Same reasoning
// already behind generateSchedule being a manual commissioner action.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getDraftClass, type NhlDraftPick } from "@/lib/nhl/client";

async function resolveDraftProspectId(year: number, pick: NhlDraftPick): Promise<string> {
  const sourceId = `${year}-${pick.overallPick}`;
  const existing = await prisma.playerSourceId.findUnique({
    where: { source_sourceId: { source: "nhl-draft", sourceId } },
  });
  if (existing) return existing.playerId;

  const fullName = `${pick.firstName.default} ${pick.lastName.default}`;
  try {
    const player = await prisma.player.create({
      data: {
        fullName,
        primaryPosition: pick.positionCode,
        currentNhlOrg: pick.teamAbbrev,
        careerNhlGp: 0,
        draftYear: year,
        draftRound: pick.round,
        draftOverallPick: pick.overallPick,
        amateurLeague: pick.amateurLeague,
        amateurClubName: pick.amateurClubName,
        sourceIds: { create: { source: "nhl-draft", sourceId } },
      },
    });
    return player.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const nowExisting = await prisma.playerSourceId.findUnique({
        where: { source_sourceId: { source: "nhl-draft", sourceId } },
      });
      if (nowExisting) return nowExisting.playerId;
    }
    throw e;
  }
}

export interface IngestDraftClassResult {
  year: number;
  picksSeen: number;
  playersCreated: number;
}

export async function ingestDraftClass(year: number): Promise<IngestDraftClassResult> {
  const { picks } = await getDraftClass(year);
  let created = 0;

  for (const pick of picks) {
    const before = await prisma.playerSourceId.findUnique({
      where: { source_sourceId: { source: "nhl-draft", sourceId: `${year}-${pick.overallPick}` } },
    });
    await resolveDraftProspectId(year, pick);
    if (!before) created++;
  }

  return { year, picksSeen: picks.length, playersCreated: created };
}
