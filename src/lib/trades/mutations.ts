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
import { isLeagueCommissioner, isTeamManager, managerOrCoManagerWhere } from "@/lib/leagues/mutations";
import { activeRosterCap } from "@/lib/rosters/mutations";
import { getAvailableBudget, getOrInitFaabBudget } from "@/lib/faab/mutations";
import { clearLineupFrom, ensureLineupMaterialized } from "@/lib/lineups/mutations";
import { todayUTC } from "@/lib/dates";
import { assertPlayersNotTradeLocked, getTradeLockedPlayerIds } from "@/lib/trades/locks";

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
    // Trade integrity (plans/trades-batch.md Task 1) — lets the builder (Task
    // 2/3) disable a row and show why, rather than letting the user select an
    // asset that proposeTrade would just reject anyway.
    lockedInTradeId: string | null;
    onWaiversUntil: Date | null;
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

  const lockedByPlayer = await getTradeLockedPlayerIds(team.leagueId, slots.map((s) => s.playerId));
  const now = Date.now();

  return {
    players: slots.map((s) => ({
      id: s.playerId,
      fullName: s.player.fullName,
      primaryPosition: s.player.primaryPosition,
      currentNhlOrg: s.player.currentNhlOrg,
      headshotUrl: s.player.headshotUrl,
      slotType: s.slotType,
      lockedInTradeId: lockedByPlayer.get(s.playerId) ?? null,
      onWaiversUntil: s.waiverExpiresAt && s.waiverExpiresAt.getTime() > now ? s.waiverExpiresAt : null,
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

export interface ProposalItemDraft {
  fromTeamId: string;
  toTeamId: string;
  itemType: "PLAYER" | "PICK" | "FAAB";
  playerId?: string;
  draftPickId?: string;
  faabAmount?: number;
}

/** Pure item-list construction, extracted from proposeTrade so both it and
 * the builder's pre-flight fit-check action (Task 3's checkTradeFitAction)
 * can build the same shape without duplicating the give/receive -> per-item
 * fromTeamId/toTeamId mapping. */
export function buildProposalItems(input: {
  proposingTeamId: string;
  counterpartyTeamId: string;
  give: TradeAssetSelection;
  receive: TradeAssetSelection;
}): ProposalItemDraft[] {
  return [
    ...input.give.playerIds.map((playerId) => ({
      fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "PLAYER" as const, playerId,
    })),
    ...input.receive.playerIds.map((playerId) => ({
      fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "PLAYER" as const, playerId,
    })),
    ...input.give.pickIds.map((draftPickId) => ({
      fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "PICK" as const, draftPickId,
    })),
    ...input.receive.pickIds.map((draftPickId) => ({
      fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "PICK" as const, draftPickId,
    })),
    ...(input.give.faabAmount > 0
      ? [{ fromTeamId: input.proposingTeamId, toTeamId: input.counterpartyTeamId, itemType: "FAAB" as const, faabAmount: input.give.faabAmount }]
      : []),
    ...(input.receive.faabAmount > 0
      ? [{ fromTeamId: input.counterpartyTeamId, toTeamId: input.proposingTeamId, itemType: "FAAB" as const, faabAmount: input.receive.faabAmount }]
      : []),
  ];
}

/** Throws naming the first player found sitting in a waiver claim window
 * (RosterSlot.waiverExpiresAt still in the future) — another team may claim
 * him mid-trade, so he's blocked from being traded at all rather than trying
 * to reconcile a claim against a pending trade. */
export async function assertPlayersNotOnWaivers(playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  const slot = await prisma.rosterSlot.findFirst({
    where: { playerId: { in: playerIds }, effectiveTo: null, waiverExpiresAt: { gt: new Date() } },
    include: { player: { select: { fullName: true } } },
  });
  if (slot) {
    throw new Error(`${slot.player.fullName} is on waivers until ${slot.waiverExpiresAt!.toISOString()} and can't be traded.`);
  }
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
  if (!isTeamManager(proposingTeam, input.managerUserId)) throw new Error("You don't manage this team.");
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

  // Trade integrity (plans/trades-batch.md Task 1, issues #4/#5): a locked
  // (already-UNDER_REVIEW-elsewhere) or on-waivers player can't be offered
  // or requested on either side of a *new* proposal.
  const allPlayerIds = [...input.give.playerIds, ...input.receive.playerIds];
  await assertPlayersNotTradeLocked(input.leagueId, allPlayerIds, "traded");
  await assertPlayersNotOnWaivers(allPlayerIds);

  if (input.give.faabAmount > 0) {
    const available = await getAvailableBudget(input.proposingTeamId, proposingTeam.league.currentSeason, settings.faabBudget);
    if (input.give.faabAmount > available) throw new Error(`You only have $${available} FAAB available to offer.`);
  }
  if (input.receive.faabAmount > 0) {
    const available = await getAvailableBudget(input.counterpartyTeamId, proposingTeam.league.currentSeason, settings.faabBudget);
    if (input.receive.faabAmount > available) throw new Error(`${counterpartyTeam.name} only has $${available} FAAB available.`);
  }

  const draftItems = buildProposalItems({
    proposingTeamId: input.proposingTeamId,
    counterpartyTeamId: input.counterpartyTeamId,
    give: input.give,
    receive: input.receive,
  });

  // Fit is the *proposer's* responsibility at propose time — the
  // counterparty's own room (if any) is only checked when they accept
  // (respondToTrade). This is deliberately allowed to reach UNDER_REVIEW
  // with the proposer no longer fitting if they add players after
  // proposing — that's what the stuck-trade notification is for.
  const proposeFit = await computeTradeFit(input.leagueId, draftItems);
  const proposerOverflow = worstOverflowForTeam(proposeFit, input.proposingTeamId);
  if (proposerOverflow) {
    throw new Error(
      `This trade would leave you ${proposerOverflow.excess} over your ${TIER_LABEL[proposerOverflow.slotType]} roster cap — drop ${proposerOverflow.excess} player(s) first or add more of yours to the offer.`,
    );
  }

  const tradeId = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.create({
      data: { leagueId: input.leagueId, proposedByTeamId: input.proposingTeamId, state: "PROPOSED" },
    });

    const items = draftItems.map((item) => ({ tradeId: trade.id, ...item }));
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
  if (!counterpartyTeam || !isTeamManager(counterpartyTeam, input.managerUserId)) {
    throw new Error("You don't manage the team this trade was sent to.");
  }

  if (input.accept) {
    // Full re-validation, as if proposing fresh (Rules, plans/trades-batch.md
    // Task 1): ownership, locks, waivers, and FAAB availability can all have
    // drifted since this trade was proposed.
    await assertItemsStillOwned(trade.items);

    const playerIds = trade.items
      .filter((i): i is typeof i & { playerId: string } => i.itemType === "PLAYER" && !!i.playerId)
      .map((i) => i.playerId);
    await assertPlayersNotTradeLocked(trade.leagueId, playerIds, "traded");
    await assertPlayersNotOnWaivers(playerIds);

    const league = await prisma.league.findUniqueOrThrow({ where: { id: trade.leagueId } });
    const settings = league.settingsJson as unknown as LeagueSettings;
    await assertFaabStillAvailable(trade.items, league.currentSeason, settings.faabBudget);

    // Fit is the *acceptor's* responsibility here — the proposer's room was
    // already their own problem to solve at propose time.
    const fit = await computeTradeFit(trade.leagueId, trade.items);
    const acceptorOverflow = worstOverflowForTeam(fit, counterpartyTeamId);
    if (acceptorOverflow) {
      throw new Error(`You must drop ${acceptorOverflow.excess} player(s) to accept this trade.`);
    }

    const now = new Date();
    // Accepting supersedes every other still-PROPOSED trade in the league
    // touching any of the same players (either side) — otherwise one of
    // those could be accepted later and fail at processing because the
    // player's already gone.
    const superseded = playerIds.length > 0
      ? await prisma.trade.findMany({
          where: {
            leagueId: trade.leagueId,
            state: "PROPOSED",
            id: { not: trade.id },
            items: { some: { itemType: "PLAYER", playerId: { in: playerIds } } },
          },
          select: { id: true },
        })
      : [];

    await prisma.$transaction([
      prisma.trade.update({
        where: { id: input.tradeId },
        data: { state: "UNDER_REVIEW", respondedAt: now, reviewEndsAt: new Date(now.getTime() + REVIEW_WINDOW_MS) },
      }),
      prisma.transactionLog.create({
        data: { leagueId: trade.leagueId, type: "TRADE", actorTeamId: counterpartyTeamId, payload: { tradeId: trade.id, event: "ACCEPTED" } },
      }),
      ...superseded.flatMap((s) => [
        prisma.trade.update({ where: { id: s.id }, data: { state: "CANCELLED" } }),
        prisma.transactionLog.create({
          data: {
            leagueId: trade.leagueId,
            type: "TRADE",
            actorTeamId: counterpartyTeamId,
            payload: { tradeId: s.id, event: "SUPERSEDED", byTradeId: trade.id },
          },
        }),
      ]),
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
  /** Internal-only escape hatch for startNewSeason's forced wipe of every
   * in-flight trade — never set this from a user-facing action. Once a
   * trade has been accepted (UNDER_REVIEW), a manager or commissioner can no
   * longer back out of it via the normal cancel path; only the commissioner's
   * force-process, or the room opening up naturally, resolves it from there. */
  allowUnderReview?: boolean;
}

/** Either trading manager, or the commissioner, can cancel a still-PROPOSED
 * trade (the proposer backing out before the other side has even accepted).
 * Once accepted (UNDER_REVIEW), cancelling is no longer allowed — a stuck
 * trade's only way out is the commissioner's force-process. */
export async function cancelTrade(input: CancelTradeInput): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: input.tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");
  const cancellableStates = input.allowUnderReview ? ["PROPOSED", "UNDER_REVIEW"] : ["PROPOSED"];
  if (!cancellableStates.includes(trade.state)) {
    throw new Error(
      trade.state === "UNDER_REVIEW"
        ? "This trade has already been accepted and can no longer be cancelled — ask the commissioner to force it through if it's stuck."
        : "This trade can no longer be cancelled.",
    );
  }

  const counterpartyTeamId = getCounterpartyTeamId(trade);
  const [proposerTeam, counterpartyTeam, isCommissioner] = await Promise.all([
    prisma.team.findUnique({ where: { id: trade.proposedByTeamId } }),
    prisma.team.findUnique({ where: { id: counterpartyTeamId } }),
    isLeagueCommissioner(trade.leagueId, input.callerUserId),
  ]);
  const allowed =
    (proposerTeam && isTeamManager(proposerTeam, input.callerUserId)) ||
    (counterpartyTeam && isTeamManager(counterpartyTeam, input.callerUserId)) ||
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

  const callerTeam = await prisma.team.findFirst({ where: { leagueId: trade.leagueId, ...managerOrCoManagerWhere(input.managerUserId) } });
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
  playerId?: string | null;
}

export interface TradeFit {
  fits: boolean;
  overflow: { teamId: string; slotType: "ACTIVE" | "FARM" | "IR"; excess: number }[];
}

/** Net effect per team per slot type (current count − what's leaving of
 * that type + what's arriving of that type, using each player's CURRENT
 * slot type at check time — not a snapshot from proposal time). No existing
 * mutation in this app checks capacity for more than one team or item at
 * once; this is the first. Reports *how many* over per team per tier
 * (`overflow`), not just a bare boolean — the propose/accept flows (Task 1)
 * and the builder's pre-flight check (Task 3) both need the actual N to show
 * "drop N player(s)" rather than a generic failure. */
export async function computeTradeFit(leagueId: string, items: TradeItemForFit[]): Promise<TradeFit> {
  const playerItems = items.filter(
    (i): i is TradeItemForFit & { playerId: string } => i.itemType === "PLAYER" && !!i.playerId,
  );
  if (playerItems.length === 0) return { fits: true, overflow: [] };

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
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

  const overflow: TradeFit["overflow"] = [];
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
      if (current[slotType] > caps[slotType]) {
        overflow.push({ teamId, slotType, excess: current[slotType] - caps[slotType] });
      }
    }
  }
  return { fits: overflow.length === 0, overflow };
}

const TIER_LABEL: Record<"ACTIVE" | "FARM" | "IR", string> = { ACTIVE: "Active", FARM: "Farm", IR: "IR" };

/** The single worst (highest-excess) overflow row for one team, or null if
 * that team has none — "worst tier first" per the Rules when a team is over
 * in more than one tier at once. */
function worstOverflowForTeam(fit: TradeFit, teamId: string): TradeFit["overflow"][number] | null {
  const rows = fit.overflow.filter((o) => o.teamId === teamId);
  if (rows.length === 0) return null;
  return rows.reduce((worst, r) => (r.excess > worst.excess ? r : worst));
}

/** Re-validates every item's ownership at accept time, as if proposing
 * fresh — a player or pick may have moved on (dropped, traded elsewhere via
 * commissioner override, etc.) in the time between propose and accept. */
async function assertItemsStillOwned(
  items: { fromTeamId: string; itemType: string; playerId: string | null; draftPickId: string | null }[],
): Promise<void> {
  const playerIdsByTeam = new Map<string, string[]>();
  const pickIdsByTeam = new Map<string, string[]>();
  for (const item of items) {
    if (item.itemType === "PLAYER" && item.playerId) {
      playerIdsByTeam.set(item.fromTeamId, [...(playerIdsByTeam.get(item.fromTeamId) ?? []), item.playerId]);
    } else if (item.itemType === "PICK" && item.draftPickId) {
      pickIdsByTeam.set(item.fromTeamId, [...(pickIdsByTeam.get(item.fromTeamId) ?? []), item.draftPickId]);
    }
  }
  for (const [teamId, playerIds] of playerIdsByTeam) {
    const owned = await prisma.rosterSlot.count({ where: { teamId, playerId: { in: playerIds }, effectiveTo: null } });
    if (owned !== playerIds.length) {
      throw new Error("This trade is no longer valid — not every player is still owned by the team that offered them.");
    }
  }
  for (const [teamId, pickIds] of pickIdsByTeam) {
    const owned = await prisma.draftPick.count({ where: { id: { in: pickIds }, currentOwnerId: teamId } });
    if (owned !== pickIds.length) {
      throw new Error("This trade is no longer valid — not every pick is still owned by the team that offered them.");
    }
  }
}

/** Re-checks FAAB availability at accept time. getAvailableBudget already
 * subtracts *this* trade's own pending FAAB commitment (it's still PROPOSED
 * at the point this runs, so it's counted in the same pending-trades sum as
 * every other open trade) — add it back before comparing, otherwise a
 * trade's own promised amount would be double-counted against itself. */
async function assertFaabStillAvailable(
  items: { fromTeamId: string; itemType: string; faabAmount: number | null }[],
  season: number,
  faabBudget: number,
): Promise<void> {
  for (const item of items) {
    if (item.itemType !== "FAAB" || !item.faabAmount) continue;
    const available = await getAvailableBudget(item.fromTeamId, season, faabBudget);
    const availableExcludingThisTrade = available + item.faabAmount;
    if (item.faabAmount > availableExcludingThisTrade) {
      throw new Error(`This trade is no longer valid — insufficient FAAB (only $${availableExcludingThisTrade} available).`);
    }
  }
}

export type TradeExecutionOutcome = "PROCESSED" | "STILL_PENDING";

/** Shared by the cron path (processDueTrades) and the commissioner's
 * force-through path. bypassRoomCheck mirrors the overflow-allowed
 * philosophy already used for waiver-claim and FAAB awards — but is only
 * ever set from forceProcessTrade, never from the normal cron path. */
export async function executeTradeTransfers(tradeId: string, opts: { bypassRoomCheck?: boolean } = {}): Promise<TradeExecutionOutcome> {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, include: { items: true } });
  if (!trade) throw new Error("Trade not found.");

  if (!opts.bypassRoomCheck) {
    const fit = await computeTradeFit(trade.leagueId, trade.items);
    if (!fit.fits) return "STILL_PENDING";
  }

  const league = await prisma.league.findUniqueOrThrow({ where: { id: trade.leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  const now = new Date();

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const playerMovesForLineupClear: { teamId: string; playerId: string }[] = [];
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
      playerMovesForLineupClear.push({ teamId: item.fromTeamId, playerId: item.playerId });
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

  // A traded-away player has no business still counting toward his old
  // team's lineup/score from today forward — same stale-LineupEntry scoring
  // bug already fixed for drops/farm/IR moves (src/lib/rosters/mutations.ts).
  // Runs regardless of caller (cron-driven processDueTrades or a
  // commissioner's forceProcessTrade) since it's fixing a real bug, not an
  // interactive-only convenience.
  for (const { teamId, playerId } of playerMovesForLineupClear) {
    await clearLineupFrom(teamId, playerId);
  }

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
  const callerTeam = await prisma.team.findFirst({ where: { leagueId: trade.leagueId, ...managerOrCoManagerWhere(input.callerUserId) } });
  const counterpartyTeamId = getCounterpartyTeamId(trade);
  if (callerTeam && (callerTeam.id === trade.proposedByTeamId || callerTeam.id === counterpartyTeamId)) {
    throw new Error("You can't force-process a trade you're part of, even as commissioner.");
  }
  if (trade.state !== "UNDER_REVIEW") throw new Error("Only an accepted (under-review) trade can be forced through.");

  const outcome = await executeTradeTransfers(input.tradeId, { bypassRoomCheck: true });
  // Interactive path (unlike the cron's processDueTrades, which is followed
  // by its own bulk yesterday+today materialize step for every team) — both
  // sides need their lineups materialized right away so a newly-acquired
  // player shows up in an open slot instead of waiting for tomorrow's cron.
  if (outcome === "PROCESSED") {
    await Promise.all([
      ensureLineupMaterialized(trade.proposedByTeamId, todayUTC()),
      ensureLineupMaterialized(counterpartyTeamId, todayUTC()),
    ]);
  }
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
  playerId?: string;
  playerName?: string;
  pickId?: string;
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

type TradeWithFullItems = Prisma.TradeGetPayload<{
  include: { items: { include: { player: true; draftPick: true; fromTeam: true; toTeam: true } }; vetoes: true };
}>;

/** Shared by getTradesForLeague (list) and getTradeDetailById (single) — the
 * counterparty/proposer team names have to be derived from the first item
 * rather than a direct FK, since Trade itself only stores proposedByTeamId. */
function mapTradeToDetail(t: TradeWithFullItems, viewingTeamId: string | null): TradeDetail | null {
  const firstItem = t.items[0];
  if (!firstItem) return null;
  const counterpartyTeam = firstItem.fromTeamId === t.proposedByTeamId ? firstItem.toTeam : firstItem.fromTeam;
  const proposedByTeam = firstItem.fromTeamId === t.proposedByTeamId ? firstItem.fromTeam : firstItem.toTeam;

  return {
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
      playerId: i.playerId ?? undefined,
      playerName: i.player?.fullName,
      pickId: i.draftPickId ?? undefined,
      pickLabel: i.draftPick ? `${i.draftPick.season} Round ${i.draftPick.round}` : undefined,
      faabAmount: i.faabAmount ?? undefined,
    })),
  };
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

  return trades
    .map((t) => mapTradeToDetail(t, viewingTeamId))
    .filter((d): d is TradeDetail => d !== null);
}

/** Single-trade fetch for the review screen (propose/accept review). */
export async function getTradeDetailById(tradeId: string, viewingTeamId: string | null): Promise<TradeDetail | null> {
  const t = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: {
      items: { include: { player: true, draftPick: true, fromTeam: true, toTeam: true } },
      vetoes: true,
    },
  });
  if (!t) return null;
  return mapTradeToDetail(t, viewingTeamId);
}
