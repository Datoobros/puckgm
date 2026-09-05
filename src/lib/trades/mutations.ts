// Trades (DESIGN.md §2.11). Two-team only for this pass — TradeItem's
// per-item fromTeamId/toTeamId already generalizes to more, but the
// validation and UI here only ever handle exactly two teams.
//
// Flow: propose (nothing moves yet) -> the counterparty accepts or declines
// -> an accepted trade enters a fixed 24h review window -> the league's
// tradeVetoMode (COMMISSIONER or VOTE, a per-league setting) can veto it
// immediately, without waiting for the window to end -> once the window
// passes with no veto, it processes IF both sides have room for what
// they're receiving; if not, it stays UNDER_REVIEW and is retried on every
// later cron run rather than failing outright (explicit user direction —
// unlike waiver claims/FAAB, a trade does not bypass the roster cap on the
// normal path). The commissioner can force an already-accepted trade
// through immediately, which — like waiver claims/FAAB — does bypass both
// the remaining review time and the room check.
//
// Picks are tradeable here even though no league has any real DraftPick
// rows yet (no draft feature exists) — the mechanism is real, it will just
// have nothing to select until the draft ships.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { isLeagueCommissioner } from "@/lib/leagues/mutations";
import { activeRosterCap } from "@/lib/rosters/mutations";
import { getAvailableBudget, getOrInitFaabBudget } from "@/lib/faab/mutations";

const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TradeAssetSelection {
  playerIds: string[];
  pickIds: string[];
  faabAmount: number;
}

export interface TradeableAssets {
  players: {
    id: string;
    fullName: string;
    primaryPosition: string | null;
    currentNhlOrg: string | null;
    headshotUrl: string | null;
    slotType: string;
  }[];
  picks: { id: string; season: number; round: number }[];
  availableFaab: number;
}

export async function getTradeableAssets(teamId: string): Promise<TradeableAssets> {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, include: { league: true } });
  const settings = team.league.settingsJson as unknown as LeagueSettings;

  const [slots, picks, availableFaab] = await Promise.all([
    prisma.rosterSlot.findMany({ where: { teamId, effectiveTo: null }, include: { player: true } }),
    prisma.draftPick.findMany({ where: { currentOwnerId: teamId } }),
    getAvailableBudget(teamId, team.league.currentSeason, settings.faabBudget),
  ]);

  return {
    players: slots.map((s) => ({
      id: s.playerId,
      fullName: s.player.fullName,
      primaryPosition: s.player.primaryPosition,
      currentNhlOrg: s.player.currentNhlOrg,
      headshotUrl: s.player.headshotUrl,
      slotType: s.slotType,
    })),
    picks: picks.map((p) => ({ id: p.id, season: p.season, round: p.round })),
    availableFaab,
  };
}

interface TradeWithItemsForCounterparty {
  proposedByTeamId: string;
  items: { fromTeamId: string; toTeamId: string }[];
}

function getCounterpartyTeamId(trade: TradeWithItemsForCounterparty): string {
  const item = trade.items[0];
  if (!item) throw new Error("Trade has no items.");
  return item.fromTeamId === trade.proposedByTeamId ? item.toTeamId : item.fromTeamId;
}

export interface ProposeTradeInput {
  leagueId: string;
  proposingTeamId: string;
  counterpartyTeamId: string;
  managerUserId: string;
  give: TradeAssetSelection;
  receive: TradeAssetSelection;
}

export async function proposeTrade(input: ProposeTradeInput): Promise<{ tradeId: string }> {
  if (input.proposingTeamId === input.counterpartyTeamId) {
    throw new Error("Pick a different team to trade with.");
  }

  const [proposingTeam, counterpartyTeam] = await Promise.all([
    prisma.team.findUnique({ where: { id: input.proposingTeamId }, include: { league: true } }),
    prisma.team.findUnique({ where: { id: input.counterpartyTeamId } }),
  ]);
  if (!proposingTeam || proposingTeam.leagueId !== input.leagueId) throw new Error("Team not found in this league.");
  if (proposingTeam.managerUserId !== input.managerUserId) throw new Error("You don't manage this team.");
  if (!counterpartyTeam || counterpartyTeam.leagueId !== input.leagueId) throw new Error("Counterparty team not found in this league.");
  if (proposingTeam.state === "ORPHAN_FROZEN" || counterpartyTeam.state === "ORPHAN_FROZEN") {
    throw new Error("An orphaned team's roster is frozen — it can't trade.");
  }

  const settings = proposingTeam.league.settingsJson as unknown as LeagueSettings;
  if (settings.tradeDeadline && Date.now() > Date.parse(settings.tradeDeadline)) {
    throw new Error("This league's trade deadline has passed.");
  }

  const totalItems =
    input.give.playerIds.length + input.give.pickIds.length + (input.give.faabAmount > 0 ? 1 : 0) +
    input.receive.playerIds.length + input.receive.pickIds.length + (input.receive.faabAmount > 0 ? 1 : 0);
  if (totalItems === 0) throw new Error("A trade needs at least one asset on one side.");

  // Missing on settingsJson predates this feature — treat as the true
  // default (on), same convention as leagueType/positionMode elsewhere.
  if (settings.draftPickTradingEnabled === false && (input.give.pickIds.length > 0 || input.receive.pickIds.length > 0)) {
    throw new Error("Draft pick trading is turned off in this league.");
  }

  await assertOwnsAssets(input.proposingTeamId, input.give);
  await assertOwnsAssets(input.counterpartyTeamId, input.receive);

  if (input.give.faabAmount > 0) {
    const available = await getAvailableBudget(input.proposingTeamId, proposingTeam.league.currentSeason, settings.faabBudget);
    if (input.give.faabAmount > available) throw new Error(`You only have $${available} FAAB available to offer.`);
  }
  if (input.receive.faabAmount > 0) {
    const available = await getAvailableBudget(input.counterpartyTeamId, proposingTeam.league.currentSeason, settings.faabBudget);
    if (input.receive.faabAmount > available) throw new Error(`${counterpartyTeam.name} only has $${available} FAAB available.`);
  }

  const tradeId = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.create({
      data: { leagueId: input.leagueId, proposedByTeamId: input.proposingTeamId, state: "PROPOSED" },
    });

    const items: {
      tradeId: string;
      fromTeamId: string;
      toTeamId: string;
      itemType: "PLAYER" | "PICK" | "FAAB";
      playerId?: string;
      draftPickId?: string;
      faabAmount?: number;
    }[] = [
      ...input.give.playerIds.map((playerId) => ({
        tradeId: trade.id, fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "PLAYER" as const, playerId,
      })),
      ...input.receive.playerIds.map((playerId) => ({
        tradeId: trade.id, fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "PLAYER" as const, playerId,
      })),
      ...input.give.pickIds.map((draftPickId) => ({
        tradeId: trade.id, fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "PICK" as const, draftPickId,
      })),
      ...input.receive.pickIds.map((draftPickId) => ({
        tradeId: trade.id, fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "PICK" as const, draftPickId,
      })),
      ...(input.give.faabAmount > 0
        ? [{ tradeId: trade.id, fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "FAAB" as const, faabAmount: input.give.faabAmount }]
        : []),
      ...(input.receive.faabAmount > 0
        ? [{ tradeId: trade.id, fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "FAAB" as const, faabAmount: input.receive.faabAmount }]
        : []),
    ];
    await tx.tradeItem.createMany({ data: items });
    await tx.transactionLog.create({
      data: { leagueId: input.leagueId, type: "TRADE", actorTeamId: input.proposingTeamId, payload: { tradeId: trade.id, event: "PROPOSED" } },
    });
    return trade.id;
  });

  return { tradeId };
}

async function assertOwnsAssets(teamId: string, assets: TradeAssetSelection): Promise<void> {
  if (assets.playerIds.length > 0) {
    const owned = await prisma.rosterSlot.count({
      where: { teamId, playerId: { in: assets.playerIds }, effectiveTo: null },
    });
    if (owned !== assets.playerIds.length) throw new Error("Not every selected player is currently owned by the claimed team.");
  }
  if (assets.pickIds.length > 0) {
    const owned = await prisma.draftPick.count({ where: { id: { in: assets.pickIds }, currentOwnerId: teamId } });
    if (owned !== assets.pickIds.length) throw new Error("Not every selected pick is currently owned by the claimed team.");
  }
}

export interface RespondToTradeInput {
  tradeId: string;
  managerUserId: string;
  accept: boolean;
}

export async function respondToTrade(input: RespondToTradeInput): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");
  if (trade.state !== "PROPOSED") throw new Error("This trade is no longer awaiting a response.");

  const counterpartyTeamId = getCounterpartyTeamId(trade);
  const counterpartyTeam = await prisma.team.findUnique({ where: { id: counterpartyTeamId } });
  if (!counterpartyTeam || counterpartyTeam.managerUserId !== input.managerUserId) {
    throw new Error("You don't manage the team this trade was sent to.");
  }

  if (input.accept) {
    const now = new Date();
    await prisma.$transaction([
      prisma.trade.update({
        where: { id: input.tradeId },
        data: { state: "UNDER_REVIEW", respondedAt: now, reviewEndsAt: new Date(now.getTime() + REVIEW_WINDOW_MS) },
      }),
      prisma.transactionLog.create({
        data: { leagueId: trade.leagueId, type: "TRADE", actorTeamId: counterpartyTeamId, payload: { tradeId: trade.id, event: "ACCEPTED" } },
      }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.trade.update({ where: { id: input.tradeId }, data: { state: "DECLINED" } }),
      prisma.transactionLog.create({
        data: { leagueId: trade.leagueId, type: "TRADE", actorTeamId: counterpartyTeamId, payload: { tradeId: trade.id, event: "DECLINED" } },
      }),
    ]);
  }
}

export interface CancelTradeInput {
  tradeId: string;
  callerUserId: string;
}

/** Either trading manager, or the commissioner, can cancel — this is the
 * escape hatch for a trade stuck UNDER_REVIEW waiting on roster room, and
 * how the proposer backs out early. */
export async function cancelTrade(input: CancelTradeInput): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");
  if (trade.state !== "PROPOSED" && trade.state !== "UNDER_REVIEW") {
    throw new Error("This trade can no longer be cancelled.");
  }

  const counterpartyTeamId = getCounterpartyTeamId(trade);
  const [proposerTeam, counterpartyTeam, isCommissioner] = await Promise.all([
    prisma.team.findUnique({ where: { id: trade.proposedByTeamId } }),
    prisma.team.findUnique({ where: { id: counterpartyTeamId } }),
    isLeagueCommissioner(trade.leagueId, input.callerUserId),
  ]);
  const allowed =
    proposerTeam?.managerUserId === input.callerUserId ||
    counterpartyTeam?.managerUserId === input.callerUserId ||
    isCommissioner;
  if (!allowed) throw new Error("You aren't part of this trade.");

  await prisma.$transaction([
    prisma.trade.update({ where: { id: input.tradeId }, data: { state: "CANCELLED" } }),
    prisma.transactionLog.create({
      data: { leagueId: trade.leagueId, type: "TRADE", actorTeamId: trade.proposedByTeamId, payload: { tradeId: trade.id, event: "CANCELLED" } },
    }),
  ]);
}

async function isVetoThresholdMet(
  trade: { id: string; leagueId: string; proposedByTeamId: string; items: { fromTeamId: string; toTeamId: string }[] },
  vetoMode: "COMMISSIONER" | "VOTE",
): Promise<boolean> {
  if (vetoMode === "COMMISSIONER") {
    return (await prisma.tradeVeto.count({ where: { tradeId: trade.id } })) > 0;
  }
  const counterpartyTeamId = getCounterpartyTeamId(trade);
  const totalTeams = await prisma.team.count({ where: { leagueId: trade.leagueId } });
  const eligibleVoters = totalTeams - 2;
  if (eligibleVoters <= 0) return false;
  const votes = await prisma.tradeVeto.count({
    where: { tradeId: trade.id, teamId: { notIn: [trade.proposedByTeamId, counterpartyTeamId] } },
  });
  return votes > eligibleVoters / 2;
}

export interface CastTradeVetoInput {
  tradeId: string;
  managerUserId: string;
}

/** Resolves immediately once the threshold is met — a commissioner veto or
 * the deciding vote doesn't wait for the daily cron to take effect. */
export async function castTradeVeto(input: CastTradeVetoInput): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId }, include: { items: true, league: true } });
  if (!trade) throw new Error("Trade not found.");
  if (trade.state !== "UNDER_REVIEW") throw new Error("Only a trade under review can be vetoed.");

  const callerTeam = await prisma.team.findFirst({ where: { leagueId: trade.leagueId, managerUserId: input.managerUserId } });
  if (!callerTeam) throw new Error("You don't manage a team in this league.");

  const settings = trade.league.settingsJson as unknown as LeagueSettings;
  const counterpartyTeamId = getCounterpartyTeamId(trade);

  if (settings.tradeVetoMode === "COMMISSIONER") {
    if (!(await isLeagueCommissioner(trade.leagueId, input.managerUserId))) {
      throw new Error("Only the commissioner can veto trades in this league.");
    }
    // A co-commissioner who's a party to this specific trade can't be the
    // one deciding it — same conflict-of-interest exclusion VOTE mode
    // already applies below, just for the commissioner-veto path instead.
    if (callerTeam.id === trade.proposedByTeamId || callerTeam.id === counterpartyTeamId) {
      throw new Error("You can't veto a trade you're part of, even as commissioner.");
    }
  } else {
    if (callerTeam.id === trade.proposedByTeamId || callerTeam.id === counterpartyTeamId) {
      throw new Error("You can't vote to veto a trade you're part of.");
    }
  }

  await prisma.tradeVeto.upsert({
    where: { tradeId_teamId: { tradeId: input.tradeId, teamId: callerTeam.id } },
    create: { tradeId: input.tradeId, teamId: callerTeam.id },
    update: {},
  });

  if (await isVetoThresholdMet(trade, settings.tradeVetoMode)) {
    await prisma.$transaction([
      prisma.trade.update({ where: { id: input.tradeId }, data: { state: "VETOED" } }),
      prisma.transactionLog.create({
        data: { leagueId: trade.leagueId, type: "TRADE", actorTeamId: callerTeam.id, payload: { tradeId: trade.id, event: "VETOED" } },
      }),
    ]);
  }
}

interface TradeItemForFit {
  fromTeamId: string;
  toTeamId: string;
  itemType: string;
  playerId: string | null;
}

/** Net effect per team per slot type (current count − what's leaving of
 * that type + what's arriving of that type, using each player's CURRENT
 * slot type at check time — not a snapshot from proposal time). No existing
 * mutation in this app checks capacity for more than one team or item at
 * once; this is the first. */
async function wouldFitAfterTrade(trade: { leagueId: string; items: TradeItemForFit[] }): Promise<boolean> {
  const playerItems = trade.items.filter(
    (i): i is TradeItemForFit & { playerId: string } => i.itemType === "PLAYER" && !!i.playerId,
  );
  if (playerItems.length === 0) return true;

  const league = await prisma.league.findUniqueOrThrow({ where: { id: trade.leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  const caps: Record<"ACTIVE" | "FARM" | "IR", number> = {
    ACTIVE: activeRosterCap(settings),
    FARM: settings.farmSlots,
    IR: settings.irSlots,
  };

  const slots = await prisma.rosterSlot.findMany({
    where: { playerId: { in: playerItems.map((i) => i.playerId) }, effectiveTo: null },
  });
  const slotTypeByPlayer = new Map(slots.map((s) => [s.playerId, s.slotType]));

  const teamIds = Array.from(new Set(playerItems.flatMap((i) => [i.fromTeamId, i.toTeamId])));
  for (const teamId of teamIds) {
    const counts = await Promise.all(
      (["ACTIVE", "FARM", "IR"] as const).map((slotType) =>
        prisma.rosterSlot.count({ where: { teamId, slotType, effectiveTo: null } }),
      ),
    );
    const current: Record<"ACTIVE" | "FARM" | "IR", number> = { ACTIVE: counts[0], FARM: counts[1], IR: counts[2] };

    for (const item of playerItems) {
      const slotType = slotTypeByPlayer.get(item.playerId) as "ACTIVE" | "FARM" | "IR" | undefined;
      if (!slotType) continue;
      if (item.fromTeamId === teamId) current[slotType] -= 1;
      if (item.toTeamId === teamId) current[slotType] += 1;
    }

    for (const slotType of ["ACTIVE", "FARM", "IR"] as const) {
      if (current[slotType] > caps[slotType]) return false;
    }
  }
  return true;
}

export type TradeExecutionOutcome = "PROCESSED" | "STILL_PENDING";

/** Shared by the cron path (processDueTrades) and the commissioner's
 * force-through path. bypassRoomCheck mirrors the overflow-allowed
 * philosophy already used for waiver-claim and FAAB awards — but is only
 * ever set from forceProcessTrade, never from the normal cron path. */
export async function executeTradeTransfers(tradeId: string, opts: { bypassRoomCheck?: boolean } = {}): Promise<TradeExecutionOutcome> {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");

  if (!opts.bypassRoomCheck && !(await wouldFitAfterTrade(trade))) {
    return "STILL_PENDING";
  }

  const league = await prisma.league.findUniqueOrThrow({ where: { id: trade.leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  const now = new Date();

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const item of trade.items) {
    if (item.itemType === "PLAYER" && item.playerId) {
      const oldSlot = await prisma.rosterSlot.findFirst({
        where: { teamId: item.fromTeamId, playerId: item.playerId, effectiveTo: null },
      });
      if (!oldSlot) continue; // defensive — validated at proposal time, shouldn't happen
      ops.push(prisma.rosterSlot.update({ where: { id: oldSlot.id }, data: { effectiveTo: now } }));
      ops.push(
        prisma.rosterSlot.create({
          data: { teamId: item.toTeamId, playerId: item.playerId, slotType: oldSlot.slotType, tradeAcquiredAt: now },
        }),
      );
    } else if (item.itemType === "FAAB" && item.faabAmount) {
      const [fromBudget, toBudget] = await Promise.all([
        getOrInitFaabBudget(item.fromTeamId, league.currentSeason, settings.faabBudget),
        getOrInitFaabBudget(item.toTeamId, league.currentSeason, settings.faabBudget),
      ]);
      ops.push(prisma.faabBudget.update({ where: { id: fromBudget.id }, data: { remaining: fromBudget.remaining - item.faabAmount } }));
      ops.push(prisma.faabBudget.update({ where: { id: toBudget.id }, data: { remaining: toBudget.remaining + item.faabAmount } }));
    } else if (item.itemType === "PICK" && item.draftPickId) {
      ops.push(prisma.draftPick.update({ where: { id: item.draftPickId }, data: { currentOwnerId: item.toTeamId } }));
    }
  }

  await prisma.$transaction([
    ...ops,
    prisma.trade.update({ where: { id: tradeId }, data: { state: "PROCESSED" } }),
    prisma.transactionLog.create({
      data: {
        leagueId: trade.leagueId,
        type: "TRADE",
        actorTeamId: trade.proposedByTeamId,
        payload: { tradeId, event: opts.bypassRoomCheck ? "FORCED" : "PROCESSED", itemCount: trade.items.length },
      },
    }),
  ]);

  return "PROCESSED";
}

export interface ForceProcessTradeInput {
  tradeId: string;
  callerUserId: string;
}

export async function forceProcessTrade(input: ForceProcessTradeInput): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");
  if (!(await isLeagueCommissioner(trade.leagueId, input.callerUserId))) {
    throw new Error("Only the commissioner can force a trade through.");
  }
  const callerTeam = await prisma.team.findFirst({ where: { leagueId: trade.leagueId, managerUserId: input.callerUserId } });
  const counterpartyTeamId = getCounterpartyTeamId(trade);
  if (callerTeam && (callerTeam.id === trade.proposedByTeamId || callerTeam.id === counterpartyTeamId)) {
    throw new Error("You can't force-process a trade you're part of, even as commissioner.");
  }
  if (trade.state !== "UNDER_REVIEW") throw new Error("Only an accepted (under-review) trade can be forced through.");

  await executeTradeTransfers(input.tradeId, { bypassRoomCheck: true });
}

export interface TradeDueResult {
  tradeId: string;
  outcome: TradeExecutionOutcome;
}

/** Cron entry point, piggybacked on the same daily route as
 * processExpiredWaivers/processFaabBids. Already-vetoed trades never reach
 * here — castTradeVeto resolves them the moment the threshold is hit. */
export async function processDueTrades(): Promise<TradeDueResult[]> {
  const due = await prisma.trade.findMany({
    where: { state: "UNDER_REVIEW", reviewEndsAt: { lte: new Date() } },
  });
  const results: TradeDueResult[] = [];
  for (const trade of due) {
    const outcome = await executeTradeTransfers(trade.id);
    results.push({ tradeId: trade.id, outcome });
  }
  return results;
}

export interface TradeItemDetail {
  itemType: "PLAYER" | "PICK" | "FAAB";
  fromTeamId: string;
  toTeamId: string;
  playerName?: string;
  pickLabel?: string;
  faabAmount?: number;
}

export interface TradeDetail {
  id: string;
  state: string;
  proposedAt: Date;
  reviewEndsAt: Date | null;
  proposedByTeamId: string;
  proposedByTeamName: string;
  counterpartyTeamId: string;
  counterpartyTeamName: string;
  hasVetoed: boolean;
  items: TradeItemDetail[];
}

/** Last 50 trades league-wide, shaped for the /trades hub page to filter
 * into "needs your response" / "pending" / "history" sections by state and
 * team membership. `viewingTeamId` is only used to compute `hasVetoed`. */
export async function getTradesForLeague(leagueId: string, viewingTeamId: string | null): Promise<TradeDetail[]> {
  const trades = await prisma.trade.findMany({
    where: { leagueId },
    include: {
      items: { include: { player: true, draftPick: true, fromTeam: true, toTeam: true } },
      vetoes: true,
    },
    orderBy: { proposedAt: "desc" },
    take: 50,
  });

  const details: TradeDetail[] = [];
  for (const t of trades) {
    const firstItem = t.items[0];
    if (!firstItem) continue;
    const counterpartyTeam = firstItem.fromTeamId === t.proposedByTeamId ? firstItem.toTeam : firstItem.fromTeam;
    const proposedByTeam = firstItem.fromTeamId === t.proposedByTeamId ? firstItem.fromTeam : firstItem.toTeam;

    details.push({
      id: t.id,
      state: t.state,
      proposedAt: t.proposedAt,
      reviewEndsAt: t.reviewEndsAt,
      proposedByTeamId: t.proposedByTeamId,
      proposedByTeamName: proposedByTeam.name,
      counterpartyTeamId: counterpartyTeam.id,
      counterpartyTeamName: counterpartyTeam.name,
      hasVetoed: viewingTeamId ? t.vetoes.some((v) => v.teamId === viewingTeamId) : false,
      items: t.items.map((i) => ({
        itemType: i.itemType,
        fromTeamId: i.fromTeamId,
        toTeamId: i.toTeamId,
        playerName: i.player?.fullName,
        pickLabel: i.draftPick ? `${i.draftPick.season} Round ${i.draftPick.round}` : undefined,
        faabAmount: i.faabAmount ?? undefined,
      })),
    });
  }
  return details;
}
