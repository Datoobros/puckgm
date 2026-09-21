// The player-profile modal's data layer (plans/player-modal-batch.md Task 2)
// — one function that assembles everything the modal shows, so the modal
// itself (Task 3+) stays a thin renderer over one server call.

import { prisma } from "@/lib/db";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getPlayerStatsAggregate, statLineToRow, type PlayerStatsRow } from "@/lib/players/rankings";
import { currentAndLastSeason } from "@/lib/players/seasons";
import { NHL_TEAM_NAMES, nhlTeamLogoUrl } from "@/lib/nhl/client";
import { getFreeAgencyStatus } from "@/lib/draft/mutations";
import { getMyPendingBids } from "@/lib/faab/mutations";
import { getWatchlistedPlayerIds } from "@/lib/players/watchlist";
import { activeRosterCap } from "@/lib/rosters/ownership";

export interface PlayerProfile {
  player: {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
    sweaterNumber: number | null;
    primaryPosition: string | null;
    positionLabel: string; // C / LW / RW / D / G / "—"
    isGoalie: boolean;
    currentNhlOrg: string | null;
    nhlTeamName: string | null;
    nhlTeamLogoUrl: string | null;
    headshotUrl: string | null;
    healthStatus: "Healthy" | "IR" | "LTIR";
    draftPedigree: string | null; // "2026 · Rd 1, #4 · Erie Otters (OHL)" — null unless draftYear set
  };
  rank: { position: number; groupSize: number; groupLabel: string } | null; // this season
  averagePoints: number | null; // this season, null when 0 GP
  seasons: SeasonStatsRow[]; // [thisSeason, lastSeason?] in that order
  gameLog: GameLogRow[]; // up to 25, newest first
  transactions: TransactionEvent[]; // up to 50 events, newest first
  status: PlayerLeagueStatus;
  watching: boolean;
}

export interface SeasonStatsRow {
  label: string;
  stats: PlayerStatsRow;
  atoi: string | null; // "26:36"
}

export interface GameLogRow {
  gameId: string;
  date: string; // "YYYY-MM-DD"
  opponent: string | null; // "WSH" | "@MON" | null
  result: string | null; // "W 5-4" | "L 4-5 (OT)" | "L 2-3 (SO)" | null
  toi: string | null; // statsJson.toi as stored
  stats: PlayerStatsRow; // gamesIngested = 1, points = that game's FPTS
}

export interface TransactionDetailLine {
  fromTeam: string;
  toTeam: string;
  asset: string;
  assetSuffix: string;
}

export interface TransactionEvent {
  id: string;
  at: string;
  kind: "DRAFT" | "ADD" | "DROP" | "WAIVER" | "FAAB" | "TRADE" | "CALLUP" | "SEND_DOWN" | "IR" | "COMMISSIONER";
  verb: string; // "Traded", "Drafted", "Added", …  (rendered bold)
  headline: string; // the rest of the first line: "from Finnland to QAIY…"
  details: TransactionDetailLine[]; // trades only — one per TradeItem; empty otherwise
}

export interface PlayerLeagueStatus {
  viewerTeamId: string | null;
  viewerTeamFrozen: boolean;
  onMyTeam: { slotType: "ACTIVE" | "FARM" | "IR" } | null;
  ownedBy: { teamId: string; teamName: string; slotType: "ACTIVE" | "FARM" | "IR" } | null; // any open slot (includes viewer's own team)
  waivers: { expiresAt: string; demotingTeamId: string; demotingTeamName: string; myPendingClaimId: string | null } | null;
  freeAgencyOpen: boolean;
  faab: { minBid: number; maxBid: number | null; myPendingBid: { id: string; amount: number; targetSlot: string } | null } | null; // null when FAAB off or no viewer team
  activeCount: number;
  activeCap: number;
  activeRosterPlayers: { id: string; fullName: string }[];
}

const POSITION_LABELS: Record<string, string> = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };

function positionLabelFor(primaryPosition: string | null): string {
  return primaryPosition ? (POSITION_LABELS[primaryPosition] ?? "—") : "—";
}

/** The pool a position-rank comparison runs against — honours the league's
 * positionMode (SEPARATE keeps C/LW/RW distinct, COMBINED folds them into
 * one "F" group), same rule lineup-slot eligibility uses. */
function positionGroupFor(
  primaryPosition: string | null,
  positionMode: "SEPARATE" | "COMBINED",
): { positions: string[]; label: string } {
  if (primaryPosition === "G") return { positions: ["G"], label: "G" };
  if (primaryPosition === "D") return { positions: ["D"], label: "D" };
  if (positionMode === "COMBINED") return { positions: ["C", "L", "R"], label: "F" };
  if (primaryPosition === "L") return { positions: ["L"], label: "LW" };
  if (primaryPosition === "R") return { positions: ["R"], label: "RW" };
  return { positions: ["C"], label: "C" };
}

function healthStatusFor(officialRosterStatus: string | null): "Healthy" | "IR" | "LTIR" {
  return officialRosterStatus === "IR" || officialRosterStatus === "LTIR" ? officialRosterStatus : "Healthy";
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const idx = fullName.lastIndexOf(" ");
  if (idx === -1) return { firstName: "", lastName: fullName };
  return { firstName: fullName.slice(0, idx), lastName: fullName.slice(idx + 1) };
}

function buildDraftPedigree(player: {
  draftYear: number | null;
  draftRound: number | null;
  draftOverallPick: number | null;
  amateurLeague: string | null;
  amateurClubName: string | null;
}): string | null {
  if (!player.draftYear) return null;
  let s = `${player.draftYear} · Rd ${player.draftRound}, #${player.draftOverallPick}`;
  if (player.amateurClubName) s += ` · ${player.amateurClubName} (${player.amateurLeague})`;
  return s;
}

function extractSweaterNumber(line: { statsJson: unknown } | undefined): number | null {
  if (!line) return null;
  const s = line.statsJson as Record<string, unknown>;
  const n = Number(s?.sweaterNumber);
  return Number.isFinite(n) ? n : null;
}

function parseToiSeconds(toi: unknown): number | null {
  if (typeof toi !== "string") return null;
  const m = /^(\d+):(\d{2})$/.exec(toi);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatToiSeconds(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function computeAtoi(lines: { gameDate: Date; statsJson: unknown }[], range: { start: Date; end: Date }): string | null {
  const seconds = lines
    .filter((l) => l.gameDate >= range.start && l.gameDate <= range.end)
    .map((l) => parseToiSeconds((l.statsJson as Record<string, unknown>)?.toi))
    .filter((s): s is number => s !== null);
  if (seconds.length === 0) return null;
  return formatToiSeconds(seconds.reduce((a, b) => a + b, 0) / seconds.length);
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const EXCLUDED_LOG_TYPES = new Set(["LINEUP_EDIT", "FAAB_BID", "COMMISSIONER_RESET"]);

function buildEventFromLog(
  row: { id: string; type: string; actorTeamId: string | null; payload: unknown; createdAt: Date },
  teamName: Map<string, string>,
): TransactionEvent | null {
  const payload = row.payload as Record<string, unknown>;
  const actor = (row.actorTeamId && teamName.get(row.actorTeamId)) || "A team";
  const at = row.createdAt.toISOString();

  switch (row.type) {
    case "ROSTER_ADD": {
      let headline = `by ${actor}`;
      if (payload.slotType === "FARM") headline += " to farm";
      if (payload.commissionerOverride) headline += " (commissioner)";
      return { id: row.id, at, kind: "ADD", verb: "Added", headline, details: [] };
    }
    case "ROSTER_DROP": {
      let headline = `by ${actor}`;
      if (payload.reason === "MADE_ROOM_FOR_ADD") headline += " to make room";
      if (payload.commissionerOverride) headline += " (commissioner)";
      return { id: row.id, at, kind: "DROP", verb: "Dropped", headline, details: [] };
    }
    case "CALLUP":
      return { id: row.id, at, kind: "CALLUP", verb: "Called up", headline: `to active by ${actor}`, details: [] };
    case "SEND_DOWN": {
      let headline = `to farm by ${actor}`;
      if (payload.waiverExposed) headline += " — exposed to waivers";
      return { id: row.id, at, kind: "SEND_DOWN", verb: "Sent down", headline, details: [] };
    }
    case "IR_MOVE":
      return payload.direction === "TO_IR"
        ? { id: row.id, at, kind: "IR", verb: "Placed on IR", headline: `by ${actor}`, details: [] }
        : { id: row.id, at, kind: "IR", verb: "Activated", headline: `from IR by ${actor}`, details: [] };
    case "COMMISSIONER_MOVE":
      return {
        id: row.id, at, kind: "COMMISSIONER", verb: "Moved",
        headline: `${payload.fromSlotType} → ${payload.toSlotType} by commissioner`, details: [],
      };
    case "WAIVER_CLAIM": {
      const from = (payload.fromTeamId && teamName.get(payload.fromTeamId as string)) || "another team";
      return { id: row.id, at, kind: "WAIVER", verb: "Claimed", headline: `off waivers by ${actor} from ${from}`, details: [] };
    }
    case "FAAB_WIN":
      return { id: row.id, at, kind: "FAAB", verb: "Won", headline: `on the wire by ${actor} for $${payload.amount}`, details: [] };
    case "DRAFT_PICK":
      return {
        id: row.id, at, kind: "DRAFT", verb: "Drafted",
        headline: `${ordinal(Number(payload.overallPick))} overall (${ordinal(Number(payload.round))} Rd) by ${actor}`,
        details: [],
      };
    default:
      return null;
  }
}

export interface GetPlayerProfileInput {
  leagueId: string;
  playerId: string;
  viewerUserId: string;
}

export async function getPlayerProfile(input: GetPlayerProfileInput): Promise<PlayerProfile> {
  const { leagueId, playerId, viewerUserId } = input;

  const [league, player] = await Promise.all([
    getLeague(leagueId),
    prisma.player.findUnique({ where: { id: playerId } }),
  ]);
  if (!league) throw new Error("League not found.");
  if (!player) throw new Error("Player not found.");

  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, viewerUserId)) ?? null;
  const { thisSeason, lastSeason } = currentAndLastSeason();

  const lines = await prisma.gameStatLine.findMany({
    where: { playerId },
    orderBy: { gameDate: "desc" },
  });

  const sweaterNumber = extractSweaterNumber(lines[0]);
  const { firstName, lastName } = splitName(player.fullName);

  const gameLog: GameLogRow[] = lines.slice(0, 25).map((line) => {
    const stats = line.statsJson as Record<string, unknown>;
    const opponent = line.opponentAbbrev ? (line.isHome ? line.opponentAbbrev : `@${line.opponentAbbrev}`) : null;
    let result: string | null = null;
    if (line.teamScore !== null && line.opponentScore !== null) {
      const decision = line.teamScore > line.opponentScore ? "W" : "L";
      const suffix = line.lastPeriodType === "OT" ? " (OT)" : line.lastPeriodType === "SO" ? " (SO)" : "";
      result = `${decision} ${line.teamScore}-${line.opponentScore}${suffix}`;
    }
    return {
      gameId: line.gameId,
      date: line.gameDate.toISOString().slice(0, 10),
      opponent,
      result,
      toi: typeof stats?.toi === "string" ? stats.toi : null,
      stats: statLineToRow(line, player, settings.scoringConfig),
    };
  });

  const seasonRanges = lastSeason ? [thisSeason, lastSeason] : [thisSeason];
  const seasons: SeasonStatsRow[] = [];
  for (const season of seasonRanges) {
    const [row] = await getPlayerStatsAggregate({
      playerIds: [playerId],
      dateRange: { start: season.start, end: season.end },
      scoringConfig: settings.scoringConfig,
    });
    seasons.push({ label: `${season.label} Season`, stats: row, atoi: computeAtoi(lines, season) });
  }

  // Rank / average points — this season, among the player's position group.
  let rank: PlayerProfile["rank"] = null;
  let averagePoints: number | null = null;
  const group = positionGroupFor(player.primaryPosition, settings.rosterComposition.positionMode);
  const groupRows = await getPlayerStatsAggregate({
    positions: group.positions,
    dateRange: { start: thisSeason.start, end: thisSeason.end },
    scoringConfig: settings.scoringConfig,
  });
  const filtered = groupRows.filter((r) => r.gamesIngested > 0);
  const mine = filtered.find((r) => r.id === playerId);
  if (mine) {
    const better = filtered.filter((r) => r.points > mine.points).length;
    rank = { position: 1 + better, groupSize: filtered.length, groupLabel: group.label };
    averagePoints = mine.points / mine.gamesIngested;
  }

  // Transactions, source 1: every non-trade TransactionLog row for this player.
  const rawLogs = await prisma.transactionLog.findMany({
    where: { leagueId, payload: { path: ["playerId"], equals: playerId } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const filteredLogs = rawLogs.filter((r) => {
    if (EXCLUDED_LOG_TYPES.has(r.type)) return false;
    if (r.type === "WAIVER_CLAIM") return (r.payload as { event?: string }).event === "AWARDED";
    return true;
  });
  const logTeamIds = new Set<string>();
  for (const r of filteredLogs) {
    if (r.actorTeamId) logTeamIds.add(r.actorTeamId);
    const fromTeamId = (r.payload as { fromTeamId?: string }).fromTeamId;
    if (fromTeamId) logTeamIds.add(fromTeamId);
  }
  const logTeams = logTeamIds.size > 0
    ? await prisma.team.findMany({ where: { id: { in: [...logTeamIds] } }, select: { id: true, name: true } })
    : [];
  const logTeamName = new Map(logTeams.map((t) => [t.id, t.name]));
  const logEvents = filteredLogs
    .map((r) => buildEventFromLog(r, logTeamName))
    .filter((e): e is TransactionEvent => e !== null);

  // Transactions, source 2: completed trades this player was part of.
  const tradeItemRows = await prisma.tradeItem.findMany({
    where: { playerId, trade: { leagueId, state: "PROCESSED" } },
    select: { tradeId: true },
  });
  const tradeIds = [...new Set(tradeItemRows.map((r) => r.tradeId))];
  const tradeLogRows = tradeIds.length > 0
    ? await prisma.transactionLog.findMany({ where: { leagueId, type: "TRADE" } })
    : [];
  const processedAtByTradeId = new Map<string, Date>();
  for (const r of tradeLogRows) {
    const payload = r.payload as { tradeId?: string; event?: string };
    if (payload.tradeId && (payload.event === "PROCESSED" || payload.event === "FORCED")) {
      processedAtByTradeId.set(payload.tradeId, r.createdAt);
    }
  }
  const tradeEvents: TransactionEvent[] = [];
  for (const tradeId of tradeIds) {
    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: {
        items: {
          include: { player: true, draftPick: { include: { originalTeam: true } }, fromTeam: true, toTeam: true },
        },
      },
    });
    if (!trade) continue;
    const myItem = trade.items.find((i) => i.playerId === playerId);
    if (!myItem) continue;
    const headline = `from ${myItem.fromTeam.name} to ${myItem.toTeam.name}` + (trade.commissionerExecuted ? " (commissioner)" : "");
    const details: TransactionDetailLine[] = trade.items.map((item) => {
      if (item.itemType === "PLAYER" && item.player) {
        return {
          fromTeam: item.fromTeam.name,
          toTeam: item.toTeam.name,
          asset: item.player.fullName,
          assetSuffix: `, ${item.player.currentNhlOrg ?? "—"} ${positionLabelFor(item.player.primaryPosition)}`,
        };
      }
      if (item.itemType === "PICK" && item.draftPick) {
        return {
          fromTeam: item.fromTeam.name,
          toTeam: item.toTeam.name,
          asset: `${item.draftPick.season} Rd ${item.draftPick.round} pick (orig. ${item.draftPick.originalTeam.name})`,
          assetSuffix: "",
        };
      }
      return { fromTeam: item.fromTeam.name, toTeam: item.toTeam.name, asset: `$${item.faabAmount} FAAB`, assetSuffix: "" };
    });
    const at = (processedAtByTradeId.get(trade.id) ?? trade.respondedAt ?? trade.proposedAt).toISOString();
    tradeEvents.push({ id: trade.id, at, kind: "TRADE", verb: "Traded", headline, details });
  }

  const transactions = [...logEvents, ...tradeEvents].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50);

  // League status.
  const ownedSlot = await prisma.rosterSlot.findFirst({
    where: { playerId, effectiveTo: null, team: { leagueId } },
    include: { team: true },
  });
  const onMyTeam = ownedSlot && myTeam && ownedSlot.teamId === myTeam.id ? { slotType: ownedSlot.slotType } : null;
  const ownedBy = ownedSlot
    ? { teamId: ownedSlot.teamId, teamName: ownedSlot.team.name, slotType: ownedSlot.slotType }
    : null;

  const isWaived = !!(
    ownedSlot &&
    ownedSlot.slotType === "FARM" &&
    ownedSlot.waiverExpiresAt &&
    ownedSlot.waiverExpiresAt > new Date() &&
    ownedSlot.teamId !== myTeam?.id
  );
  const waivers = isWaived && ownedSlot
    ? {
        expiresAt: ownedSlot.waiverExpiresAt!.toISOString(),
        demotingTeamId: ownedSlot.teamId,
        demotingTeamName: ownedSlot.team.name,
        myPendingClaimId: myTeam
          ? (await prisma.waiverClaim.findFirst({ where: { teamId: myTeam.id, playerId, result: "PENDING" } }))?.id ?? null
          : null,
      }
    : null;

  const freeAgencyOpen = (await getFreeAgencyStatus(leagueId)).open;

  const pendingBids = myTeam && settings.faabEnabled ? await getMyPendingBids(leagueId, myTeam.id) : [];
  const myBid = pendingBids.find((b) => b.playerId === playerId) ?? null;
  const faab = settings.faabEnabled && myTeam
    ? {
        minBid: settings.faabMinBid,
        maxBid: settings.faabMaxBid,
        myPendingBid: myBid ? { id: myBid.id, amount: myBid.amount, targetSlot: myBid.targetSlot } : null,
      }
    : null;

  const myActiveRosterSlots = myTeam
    ? await prisma.rosterSlot.findMany({
        where: { teamId: myTeam.id, slotType: "ACTIVE", effectiveTo: null },
        include: { player: { select: { id: true, fullName: true } } },
      })
    : [];

  const status: PlayerLeagueStatus = {
    viewerTeamId: myTeam?.id ?? null,
    viewerTeamFrozen: myTeam?.state === "ORPHAN_FROZEN",
    onMyTeam,
    ownedBy,
    waivers,
    freeAgencyOpen,
    faab,
    activeCount: myActiveRosterSlots.length,
    activeCap: activeRosterCap(settings),
    activeRosterPlayers: myActiveRosterSlots.map((s) => ({ id: s.player.id, fullName: s.player.fullName })),
  };

  const watchlisted = await getWatchlistedPlayerIds(leagueId, viewerUserId);

  return {
    player: {
      id: player.id,
      firstName,
      lastName,
      fullName: player.fullName,
      sweaterNumber,
      primaryPosition: player.primaryPosition,
      positionLabel: positionLabelFor(player.primaryPosition),
      isGoalie: player.primaryPosition === "G",
      currentNhlOrg: player.currentNhlOrg,
      nhlTeamName: player.currentNhlOrg ? (NHL_TEAM_NAMES[player.currentNhlOrg] ?? player.currentNhlOrg) : null,
      nhlTeamLogoUrl: player.currentNhlOrg ? nhlTeamLogoUrl(player.currentNhlOrg) : null,
      headshotUrl: player.headshotUrl,
      healthStatus: healthStatusFor(player.officialRosterStatus),
      draftPedigree: buildDraftPedigree(player),
    },
    rank,
    averagePoints,
    seasons,
    gameLog,
    transactions,
    status,
    watching: watchlisted.has(playerId),
  };
}
