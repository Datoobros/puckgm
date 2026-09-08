// Roster ownership (who owns which player) — distinct from lineups (who
// starts tonight, src/lib/lineups/mutations.ts). This file also covers
// Farm/IR movement (DESIGN.md §2.3/§2.6): add/drop to ACTIVE, send-down to
// FARM, callup back to ACTIVE, and IR placement/activation. sendToFarm flags
// demotion-waiver exposure (`waiverExposed`) and opens a claim window;
// claim submission/resolution itself lives in src/lib/waivers/mutations.ts
// (DESIGN.md §2.9's "demotion waivers").
//
// First real use of TransactionLog (DESIGN.md §4.1) — every add/drop writes
// an immutable row. That's the append-only history "why does this team own
// this player" is supposed to answer later; skipping it here would mean
// building the first roster-mutating feature without ever exercising it.

import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { isLeagueCommissioner, isTeamManager } from "@/lib/leagues/mutations";
import { voidPendingClaimsForPlayer } from "@/lib/waivers/mutations";
import { parseGameDate, setLineupSlot, swapLineupSlots } from "@/lib/lineups/mutations";

export function activeRosterCap(settings: LeagueSettings): number {
  // Object.values would also pick up positionMode ("SEPARATE"/"COMBINED"), a
  // string, not a slot count — exclude it explicitly rather than summing
  // every value blindly.
  const { positionMode: _positionMode, ...counts } = settings.rosterComposition;
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// A player is officially on IR per real data (src/lib/players/injuries.ts,
// synced from ESPN) — LTIR isn't distinguished from IR by that source, but
// the field can carry either value, so both gate the same way here.
const IR_STATUSES = new Set(["IR", "LTIR"]);

/** The week a callup counts against: the league's own matchup period
 * covering "now" if a schedule has been generated and today falls inside
 * one, else a plain Mon-Sun UTC calendar week. */
async function getCallupWeekRange(leagueId: string): Promise<{ start: Date; end: Date }> {
  const now = new Date();
  const period = await prisma.matchupPeriod.findFirst({
    where: { leagueId, startDate: { lte: now }, endDate: { gte: now } },
  });
  if (period) return { start: period.startDate, end: period.endDate };

  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

export async function getCallupsUsedThisWeek(teamId: string, leagueId: string): Promise<number> {
  const { start, end } = await getCallupWeekRange(leagueId);
  return prisma.transactionLog.count({
    where: { actorTeamId: teamId, type: "CALLUP", effectiveAt: { gte: start, lte: end } },
  });
}

export interface AddPlayerInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
  /** When the active roster is already full, the caller can pick an
   * existing ACTIVE player to drop in the same transaction rather than
   * getting a bare "roster is full" error with no way forward. Must
   * currently be on this team's ACTIVE roster — dropping a farm/IR player
   * wouldn't free an active slot. */
  dropPlayerId?: string;
}

export async function addPlayerToRoster(input: AddPlayerInput): Promise<void> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== input.leagueId) {
    throw new Error("Team not found in this league.");
  }
  if (!isTeamManager(team, input.managerUserId)) {
    throw new Error("You don't manage this team.");
  }
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't add players.");

  const settingsForFaab = team.league.settingsJson as unknown as LeagueSettings;
  if (settingsForFaab.faabEnabled) {
    throw new Error("This league uses FAAB — bid on the wire from the Players page instead.");
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

  let dropSlotId: string | null = null;
  let droppedPlayerId: string | null = null;
  if (activeCount >= cap) {
    if (!input.dropPlayerId) {
      throw new Error(`Active roster is full (${cap} max).`);
    }
    const dropSlot = await prisma.rosterSlot.findFirst({
      where: { teamId: input.teamId, playerId: input.dropPlayerId, slotType: "ACTIVE", effectiveTo: null },
    });
    if (!dropSlot) throw new Error("That player isn't on your active roster.");
    dropSlotId = dropSlot.id;
    droppedPlayerId = input.dropPlayerId;
  }

  await prisma.$transaction([
    ...(dropSlotId && droppedPlayerId
      ? [
          prisma.rosterSlot.update({ where: { id: dropSlotId }, data: { effectiveTo: new Date() } }),
          prisma.transactionLog.create({
            data: {
              leagueId: input.leagueId,
              type: "ROSTER_DROP",
              actorTeamId: input.teamId,
              payload: { playerId: droppedPlayerId, reason: "MADE_ROOM_FOR_ADD" },
            },
          }),
        ]
      : []),
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
  if (!isTeamManager(team, input.managerUserId)) {
    throw new Error("You don't manage this team.");
  }
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't drop players.");

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

export interface SendToFarmInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
}

const WAIVER_CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
const WAIVER_EXEMPTION_WINDOW_MS = 48 * 60 * 60 * 1000;
const TRADE_EXEMPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Free — doesn't count against the weekly callup limit (DESIGN.md §2.5:
 * only callups are capped, "send-downs are already priced by demotion
 * waivers"). `waiverExposed` flags that pricing and — see
 * src/lib/waivers/mutations.ts — opens a 48h claim window (`waiverExpiresAt`)
 * that other teams can act on. A player claimed off waivers in the last 48h,
 * or traded in the last 24h (src/lib/trades/mutations.ts), is exempt from
 * re-triggering exposure if his new team immediately sends him back down —
 * he was just acquired, re-flagging him would be double jeopardy. */
export async function sendToFarm(input: SendToFarmInput): Promise<{ waiverExposed: boolean }> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, include: { league: true } });
  if (!team || team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (!isTeamManager(team, input.managerUserId)) throw new Error("You don't manage this team.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't send players down.");

  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
  });
  if (!slot) throw new Error("Player is not on this team's active roster.");

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const farmCount = await prisma.rosterSlot.count({
    where: { teamId: input.teamId, slotType: "FARM", effectiveTo: null },
  });
  if (farmCount >= settings.farmSlots) {
    throw new Error(`Farm is full (${settings.farmSlots} max).`);
  }

  const recentlyClaimed =
    !!slot.waiverClaimedAt && Date.now() - slot.waiverClaimedAt.getTime() < WAIVER_EXEMPTION_WINDOW_MS;
  const recentlyTraded =
    !!slot.tradeAcquiredAt && Date.now() - slot.tradeAcquiredAt.getTime() < TRADE_EXEMPTION_WINDOW_MS;
  const waiverExposed = !recentlyClaimed && !recentlyTraded && slot.player.careerNhlGp >= settings.waiverGpThreshold;

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.rosterSlot.create({
      data: {
        teamId: input.teamId,
        playerId: input.playerId,
        slotType: "FARM",
        waiverExpiresAt: waiverExposed ? new Date(Date.now() + WAIVER_CLAIM_WINDOW_MS) : null,
      },
    }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "SEND_DOWN",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, waiverExposed },
      },
    }),
  ]);

  return { waiverExposed };
}

export interface CallUpInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
}

export async function callUpToActive(input: CallUpInput): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, include: { league: true } });
  if (!team || team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (!isTeamManager(team, input.managerUserId)) throw new Error("You don't manage this team.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't call up players.");

  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "FARM", effectiveTo: null },
  });
  if (!slot) throw new Error("Player is not on this team's farm.");

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = activeRosterCap(settings);
  const activeCount = await prisma.rosterSlot.count({
    where: { teamId: input.teamId, slotType: "ACTIVE", effectiveTo: null },
  });
  if (activeCount >= cap) {
    throw new Error(`Active roster is full (${cap} max) — send someone down first.`);
  }

  const used = await getCallupsUsedThisWeek(input.teamId, input.leagueId);
  if (used >= settings.callupsPerWeek) {
    throw new Error(`Callup limit reached for this week (${settings.callupsPerWeek} max).`);
  }

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.rosterSlot.create({ data: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE" } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "CALLUP",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId },
      },
    }),
  ]);

  // He's no longer sitting in a waiver window (the FARM slot just closed) —
  // any claims other teams had in flight on him are moot. See
  // src/lib/waivers/mutations.ts.
  await voidPendingClaimsForPlayer(input.playerId);
}

export interface PlaceOnIrInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
}

/** Gated on real data only (DESIGN.md §2.6) — a player must actually be
 * ESPN-reported IR/LTIR (src/lib/players/injuries.ts) to be placed here.
 * Only from ACTIVE, matching the design doc's worked example — IR exists
 * to free an active slot, so there's nothing to free if he's already on
 * the farm. */
export async function placeOnIR(input: PlaceOnIrInput): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, include: { league: true } });
  if (!team || team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (!isTeamManager(team, input.managerUserId)) throw new Error("You don't manage this team.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't place a player on IR.");

  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE", effectiveTo: null },
    include: { player: true },
  });
  if (!slot) throw new Error("Player is not on this team's active roster.");

  if (!slot.player.officialRosterStatus || !IR_STATUSES.has(slot.player.officialRosterStatus)) {
    throw new Error(`${slot.player.fullName} is not officially on IR.`);
  }

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const irCount = await prisma.rosterSlot.count({
    where: { teamId: input.teamId, slotType: "IR", effectiveTo: null },
  });
  if (irCount >= settings.irSlots) {
    throw new Error(`IR is full (${settings.irSlots} max).`);
  }

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.rosterSlot.create({ data: { teamId: input.teamId, playerId: input.playerId, slotType: "IR" } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "IR_MOVE",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, direction: "TO_IR" },
      },
    }),
  ]);
}

export interface ActivateFromIrInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  managerUserId: string;
}

/** DESIGN.md §2.6: once official status clears, activation is required
 * (within 48h — not auto-enforced here; no cron forcibly moves a player off
 * someone's roster, this just makes the move possible once real data says
 * he's clear). Blocked if the active roster is already full — send someone
 * down first, matching the design doc's worked example exactly. */
export async function activateFromIR(input: ActivateFromIrInput): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, include: { league: true } });
  if (!team || team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (!isTeamManager(team, input.managerUserId)) throw new Error("You don't manage this team.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("An orphaned team's roster is frozen — it can't activate a player from IR.");

  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, slotType: "IR", effectiveTo: null },
    include: { player: true },
  });
  if (!slot) throw new Error("Player is not on this team's IR.");

  if (slot.player.officialRosterStatus && IR_STATUSES.has(slot.player.officialRosterStatus)) {
    throw new Error(`${slot.player.fullName} is still officially on IR.`);
  }

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = activeRosterCap(settings);
  const activeCount = await prisma.rosterSlot.count({
    where: { teamId: input.teamId, slotType: "ACTIVE", effectiveTo: null },
  });
  if (activeCount >= cap) {
    throw new Error(`Active roster is full (${cap} max) — send someone down first.`);
  }

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.rosterSlot.create({ data: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE" } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "IR_MOVE",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, direction: "FROM_IR" },
      },
    }),
  ]);
}

export interface PlaceOnIrClearingLineupInput extends PlaceOnIrInput {
  date: string;
}

/** Same gate as placeOnIR, plus clears that date's now-stale LineupEntry —
 * a player who leaves the active roster has no business still counting
 * against a lineup slot's capacity. Used by the Move UI, which lets a
 * manager send a player straight to IR from a lineup row. */
export async function placeOnIrClearingLineup(input: PlaceOnIrClearingLineupInput): Promise<void> {
  await placeOnIR(input);
  await prisma.lineupEntry.deleteMany({
    where: { teamId: input.teamId, playerId: input.playerId, gameDate: parseGameDate(input.date) },
  });
}

export interface ActivateFromIrIntoSlotInput extends ActivateFromIrInput {
  date: string;
  targetSlot: string;
  displacedPlayerId: string | null;
}

/** Same gate as activateFromIR, plus lands the newly-activated player in a
 * specific lineup slot instead of leaving him implicitly on Bench. If
 * `displacedPlayerId` is given, that player is bumped to Bench (never a
 * real IR-for-IR swap — the activated player is the only one whose roster
 * tier actually changes). Two sequential mutations, not one cross-table
 * transaction: if the lineup-placement leg fails after activation succeeds,
 * the player ends up on the active roster but implicitly benched (no
 * LineupEntry yet defaults to "BE") rather than corrupted — the same
 * tolerance autoSetLineup already has for a partial-loop failure. */
export async function activateFromIrIntoSlot(input: ActivateFromIrIntoSlotInput): Promise<void> {
  await activateFromIR(input);
  if (input.displacedPlayerId) {
    await swapLineupSlots({
      leagueId: input.leagueId,
      teamId: input.teamId,
      date: input.date,
      managerUserId: input.managerUserId,
      moverId: input.playerId,
      moverDestinationSlot: input.targetSlot,
      displacedPlayerId: input.displacedPlayerId,
      displacedDestinationSlot: "BE",
    });
  } else {
    await setLineupSlot({
      leagueId: input.leagueId,
      teamId: input.teamId,
      playerId: input.playerId,
      date: input.date,
      slot: input.targetSlot,
      managerUserId: input.managerUserId,
    });
  }
}

export interface CommissionerRosterInput {
  leagueId: string;
  teamId: string;
  playerId: string;
  callerUserId: string;
}

/** Commissioner-only direct roster edits — full override, matching the
 * existing waiver-award/FAAB-win "overflow allowed" precedent: these skip
 * the cap-check branch entirely rather than threading a bypass flag
 * through the manager-facing functions above. Still blocked on a frozen
 * (ORPHAN_FROZEN) team — reassign it first. */
export async function commissionerAddPlayer(input: CommissionerRosterInput): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can directly edit another team's roster.");
  }
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (team.state === "ORPHAN_FROZEN") throw new Error("Reassign this orphaned team before editing its roster.");

  const alreadyRostered = await prisma.rosterSlot.findFirst({
    where: { playerId: input.playerId, effectiveTo: null, team: { leagueId: input.leagueId } },
    include: { team: true },
  });
  if (alreadyRostered) {
    throw new Error(
      alreadyRostered.teamId === input.teamId
        ? "This player is already on this roster."
        : `This player is already rostered by ${alreadyRostered.team.name}.`,
    );
  }

  await prisma.$transaction([
    prisma.rosterSlot.create({ data: { teamId: input.teamId, playerId: input.playerId, slotType: "ACTIVE" } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "ROSTER_ADD",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, slotType: "ACTIVE", commissionerOverride: true },
      },
    }),
  ]);
}

export async function commissionerDropPlayer(input: CommissionerRosterInput): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can directly edit another team's roster.");
  }
  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, effectiveTo: null },
  });
  if (!slot) throw new Error("Player is not on this roster.");

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "ROSTER_DROP",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, commissionerOverride: true },
      },
    }),
  ]);
}

export interface CommissionerMovePlayerInput extends CommissionerRosterInput {
  targetSlotType: "ACTIVE" | "FARM" | "IR";
}

/** Moves a player between ACTIVE/FARM/IR on their own team — no waiver
 * exposure, no callup-limit check, no cap check. A full override, not a
 * "free" version of sendToFarm/callUpToActive/placeOnIR/activateFromIR. */
export async function commissionerMovePlayer(input: CommissionerMovePlayerInput): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can directly edit another team's roster.");
  }
  const slot = await prisma.rosterSlot.findFirst({
    where: { teamId: input.teamId, playerId: input.playerId, effectiveTo: null },
  });
  if (!slot) throw new Error("Player is not on this roster.");
  if (slot.slotType === input.targetSlotType) throw new Error("Player is already in that slot.");

  await prisma.$transaction([
    prisma.rosterSlot.update({ where: { id: slot.id }, data: { effectiveTo: new Date() } }),
    prisma.rosterSlot.create({ data: { teamId: input.teamId, playerId: input.playerId, slotType: input.targetSlotType } }),
    prisma.transactionLog.create({
      data: {
        leagueId: input.leagueId,
        type: "COMMISSIONER_MOVE",
        actorTeamId: input.teamId,
        payload: { playerId: input.playerId, fromSlotType: slot.slotType, toSlotType: input.targetSlotType },
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
