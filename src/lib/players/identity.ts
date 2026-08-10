// Player identity resolution. Internal Player IDs are the source of truth;
// PlayerSourceId maps them to vendor IDs (NHL today, others later). Never key
// application logic off a vendor ID directly. See DESIGN.md §4.1.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getPlayerLanding } from "@/lib/nhl/client";

async function resolvePlayerId(
  nhlPlayerId: number,
  fallback: { fullName: string; position?: string },
): Promise<string> {
  const existing = await prisma.playerSourceId.findUnique({
    where: { source_sourceId: { source: "nhl", sourceId: String(nhlPlayerId) } },
  });
  if (existing) return existing.playerId;

  // Concurrent ingestion (see scripts/backfill-season.ts) means two games
  // can both discover the same brand-new player at once and race to create
  // it. The loser's create() throws a unique-constraint error (P2002) here
  // rather than silently corrupting anything — recover by re-reading what
  // the winner just wrote instead of failing the whole game ingest.
  try {
    const player = await prisma.player.create({
      data: {
        fullName: fallback.fullName,
        primaryPosition: fallback.position,
        sourceIds: {
          create: { source: "nhl", sourceId: String(nhlPlayerId) },
        },
      },
    });
    return player.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const nowExisting = await prisma.playerSourceId.findUnique({
        where: { source_sourceId: { source: "nhl", sourceId: String(nhlPlayerId) } },
      });
      if (nowExisting) return nowExisting.playerId;
    }
    throw e;
  }
}

/**
 * Cheap path used during game ingestion — creates a minimal Player row from
 * boxscore data (abbreviated first name, e.g. "M. Backlund") if one doesn't
 * exist yet. Does NOT hit the landing endpoint; fetching a full profile per
 * player per game would multiply request volume for no benefit at ingest
 * time. Full profile enrichment happens separately via upsertPlayerFull,
 * run against team rosters (see syncAllRosters).
 */
export async function ensurePlayerStub(
  nhlPlayerId: number,
  boxscoreName: string,
  position?: string,
): Promise<string> {
  return resolvePlayerId(nhlPlayerId, { fullName: boxscoreName, position });
}

/**
 * Full profile upsert from the NHL landing endpoint — proper full name, dob,
 * shoots, org, and career NHL games played (drives the 80-GP waiver
 * exemption, DESIGN.md §2.3).
 */
export async function upsertPlayerFull(nhlPlayerId: number): Promise<string> {
  const landing = await getPlayerLanding(nhlPlayerId);
  const fullName = `${landing.firstName.default} ${landing.lastName.default}`;

  const playerId = await resolvePlayerId(nhlPlayerId, {
    fullName,
    position: landing.position,
  });

  await prisma.player.update({
    where: { id: playerId },
    data: {
      fullName,
      dob: landing.birthDate ? new Date(landing.birthDate) : undefined,
      primaryPosition: landing.position,
      shoots: landing.shootsCatches,
      currentNhlOrg: landing.currentTeamAbbrev,
      careerNhlGp: landing.careerTotals?.regularSeason?.gamesPlayed ?? 0,
    },
  });

  return playerId;
}
