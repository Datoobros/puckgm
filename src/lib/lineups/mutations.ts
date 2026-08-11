// Lineups — who plays tonight, drawn from a team's ACTIVE roster only.
// Distinct from roster ownership (src/lib/rosters/mutations.ts): owning a
// player and starting him are two different questions. DESIGN.md §2.4.
//
// Slot values are unnumbered position groups ("C", "L", "R", "D", "G",
// "UTIL", "BE"), not per-slot labels like "C1"/"C2" — the schema comment on
// LineupEntry.lineupSlot uses numbered slots only as an example. Multiple
// players can share slot "C" the same day; capacity is enforced by counting
// rows per (team, date, slot) against the league's rosterComposition, not by
// the DB's uniqueness (which is only teamId+playerId+gameDate). Simpler to
// build and nothing downstream parses the string yet.
//
// Slot codes ("L"/"R") deliberately match Player.primaryPosition's stored
// values (NHL's single-letter positionCode) rather than RosterComposition's
// key names ("LW"/"RW", set at league creation — see src/app/leagues/new).
// Those two naming schemes just don't agree; capFor() bridges them.

import { prisma } from "@/lib/db";
import type { LeagueSettings, RosterComposition } from "@/lib/leagues/mutations";
import { getTeamGamesForDate, isLocked } from "@/lib/lineups/schedule";

const STARTER_ELIGIBILITY: Record<string, string[] | null> = {
  C: ["C"],
  L: ["L"],
  R: ["R"],
  D: ["D"],
  G: ["G"],
  UTIL: ["C", "L", "R", "D"],
  BE: null, // any position can sit
};

export const LINEUP_SLOTS = Object.keys(STARTER_ELIGIBILITY);

export function capFor(slot: string, comp: RosterComposition): number | null {
  if (slot === "BE") return null; // bench isn't capacity-limited, it's the leftover state
  if (slot === "L") return comp.LW;
  if (slot === "R") return comp.RW;
  return comp[slot as keyof RosterComposition] ?? 0;
}

/** Starting slots (excluding BE, which is always available) a position can fill. */
export function eligibleSlotsForPosition(position: string | null): string[] {
  if (!position) return [];
  return Object.entries(STARTER_ELIGIBILITY)
    .filter(([slot, positions]) => slot !== "BE" && positions?.includes(position))
    .map(([slot]) => slot);
}

function parseGameDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function getLineupForDate(teamId: string, date: string) {
  return prisma.lineupEntry.findMany({
    where: { teamId, gameDate: parseGameDate(date) },
  });
}

export interface SetLineupSlotInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  date: string; // "YYYY-MM-DD"
  slot: string;
  managerUserId: string;
}

export async function setLineupSlot(input: SetLineupSlotInput): Promise<void> {
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

  const eligible = STARTER_ELIGIBILITY[input.slot];
  if (eligible === undefined) throw new Error(`Unknown lineup slot "${input.slot}".`);

  const rosterSlot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
  });
  if (!rosterSlot) throw new Error("Player is not on this team's active roster.");

  if (eligible && !eligible.includes(rosterSlot.player.primaryPosition ?? "")) {
    throw new Error(`${rosterSlot.player.fullName} isn't eligible for ${input.slot}.`);
  }

  // Per-game lock: DESIGN.md §2.4 — a player locks when his own game begins,
  // nothing else. No lock at all if he has no game that day.
  if (rosterSlot.player.currentNhlOrg) {
    const games = await getTeamGamesForDate(input.date);
    const game = games.get(rosterSlot.player.currentNhlOrg);
    if (game && isLocked(game)) {
      throw new Error(`${rosterSlot.player.fullName}'s game has already started — locked for this date.`);
    }
  }

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = capFor(input.slot, settings.rosterComposition);
  if (cap !== null) {
    const occupied = await prisma.lineupEntry.count({
      where: {
        teamId: input.teamId,
        gameDate: parseGameDate(input.date),
        lineupSlot: input.slot,
        playerId: { not: input.playerId },
      },
    });
    if (occupied >= cap) {
      throw new Error(`All ${cap} ${input.slot} slot${cap === 1 ? "" : "s"} are already filled for this date.`);
    }
  }

  const gameDate = parseGameDate(input.date);

  await prisma.$transaction([
    prisma.lineupEntry.upsert({
      where: { teamId_playerId_gameDate: { teamId: input.teamId, playerId: input.playerId, gameDate } },
      update: { lineupSlot: input.slot },
      create: { teamId: input.teamId, playerId: input.playerId, gameDate, lineupSlot: input.slot },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "LINEUP_EDIT",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, date: input.date, slot: input.slot },
      },
    }),
  ]);
}
