// Roster ownership (who owns which player) — distinct from lineups (who
// starts tonight, built later) and distinct from farm/IR/waivers (Stage 5,
// DESIGN.md §2.3/§2.6, not built yet). This is deliberately just: add a
// player to your ACTIVE roster, drop a player, nothing more.
//
// First real use of TransactionLog (DESIGN.md §4.1) — every add/drop writes
// an immutable row. That's the append-only history "why does this team own
// this player" is supposed to answer later; skipping it here would mean
// building the first roster-mutating feature without ever exercising it.

import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";

function activeRosterCap(settings: LeagueSettings): number {
  return Object.values(settings.rosterComposition).reduce((sum, n) => sum + n, 0);
}

export interface AddPlayerInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
}

export async function addPlayerToRoster(input: AddPlayerInput): Promise<void> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (team.managerUserId !== input.managerUserId) {
    throw new Error("You don't manage this team.");
  }

  const alreadyRostered = await prisma.rosterSlot.findFirst({
    where: {
      playerId: input.playerId,
      effectiveTo: null,
      team: { leagueId: input.leagueId },
    },
    include: { team: true },
  });
  if (alreadyRostered) {
    throw new Error(
      alreadyRostered.teamId === input.teamId
        ? "This player is already on your roster."
        : `This player is already rostered by ${alreadyRostered.team.name}.`,
    );
  }

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = activeRosterCap(settings);
  const activeCount = await prisma.rosterSlot.count({
    where: { teamId: input.teamId, slotType: "ACTIVE", effectiveTo: null },
  });
  if (activeCount >= cap) {
    throw new Error(`Active roster is full (${cap} max).`);
  }

  await prisma.$transaction([
    prisma.rosterSlot.create({
      data: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE" },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "ROSTER_ADD",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, slotType: "ACTIVE" },
      },
    }),
  ]);
}

export interface DropPlayerInput {
  teamId: string;
  playerId: string;
  managerUserId: string;
}

export async function dropPlayerFromRoster(input: DropPlayerInput): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId } });
  if (!team) throw new Error("Team not found.");
  if (team.managerUserId !== input.managerUserId) {
    throw new Error("You don't manage this team.");
  }

  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, effectiveTo: null },
  });
  if (!slot) throw new Error("Player is not on this roster.");

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.transactionLog.create({
      data: {
        leagueId: team.leagueId,
        type: "ROSTER_DROP",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId },
      },
    }),
  ]);
}

export async function getTeamRosterView(teamId: string) {
  return prisma.rosterSlot.findMany({
    where: { teamId, effectiveTo: null },
    include: { player: true },
    orderBy: { effectiveFrom: "asc" },
  });
}

/** playerId -> owning team name, scoped to one league. Used by the players
 * page to show ownership status instead of letting an Add click fail. */
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

/** teamId -> active roster count, for the league/home dashboard cards. */
export async function getRosterCounts(teamIds: string[]): Promise<Map<string, number>> {
  if (teamIds.length === 0) return new Map();
  const grouped = await prisma.rosterSlot.groupBy({
    by: ["teamId"],
    where: { teamId: { in: teamIds }, slotType: "ACTIVE", effectiveTo: null },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.teamId, g._count._all]));
}
