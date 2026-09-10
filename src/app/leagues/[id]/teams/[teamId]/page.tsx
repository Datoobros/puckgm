import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView, getCallupsUsedThisWeek, activeRosterCap } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate, getPlayerDailyStats, type PlayerStatsRow } from "@/lib/players/rankings";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import { seasonByValue } from "@/lib/players/seasons";
import { getLineupForDate, capFor, eligibleSlotsForPosition, lineupSlotsFor } from "@/lib/lineups/mutations";
import { getTeamGamesForDate, isLocked, type TeamGameInfo } from "@/lib/lineups/schedule";
import { isLeagueCommissioner, isTeamManager, type LeagueSettings, type RosterComposition } from "@/lib/leagues/mutations";
import { getTeamSchedule } from "@/lib/matchups/standings";
import { getTeamDraftPicks } from "@/lib/draft/mutations";
import { getUserDisplayName } from "@/lib/users/display";
import { todayUTC, shiftDate, DATE_RE } from "@/lib/dates";
import { Card, SectionLabel } from "@/components/Card";
import { Button, LinkButton, Badge } from "@/components/Button";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { TeamLogo } from "@/components/TeamLogo";
import { TeamScheduleList } from "@/components/TeamScheduleList";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import {
  dropPlayerAction,
  sendToFarmAction,
  callUpAction,
  commissionerDropPlayerAction,
  commissionerMovePlayerAction,
  regenerateCoManagerClaimCodeAction,
  removeCoManagerAction,
} from "./actions";
import { RosterMoveBoard } from "./RosterMoveBoard";
import type {
  MoveBoardRow,
  MoveBoardBadge,
  MoveBoardStatCell,
  MoveBoardIrRow,
  MoveOption,
  MoveSourceTier,
} from "./moveTypes";
import { ViewControls } from "./ViewControls";
import { DateStrip } from "./DateStrip";
import { AutoSetLineupButton } from "./AutoSetLineupButton";
import { CommissionerAddPlayerBox } from "./CommissionerAddPlayerBox";
import { LogoUploadForm } from "./LogoUploadForm";
import { getTeamNotifications } from "@/lib/notifications/feed";

const NOTIFICATION_DOT: Record<string, string> = {
  TRADE_ACTION: "bg-gold",
  TRADE_PENDING: "bg-blue",
  WAIVER_PENDING: "bg-blue",
  WAIVER_RESULT: "bg-gold",
  FAAB_PENDING: "bg-blue",
  FAAB_RESULT: "bg-gold",
  ROSTER: "bg-danger",
};

const SLOT_LABELS: Record<string, string> = { C: "C", L: "L", R: "R", F: "F", D: "D", G: "G", UTIL: "UTIL", BE: "Bench" };

// Row ordering for the ESPN-style layout: players sort into their current
// lineup slot (not roster-add order) — C block, then L, then R, then D, then
// UTIL, then Bench. A visual divider is coarser than the sort: C/L/R don't
// get a line between them, only before D / UTIL / Bench do.
const SKATER_SLOT_ORDER = ["C", "L", "R", "F", "D", "UTIL", "BE"];
const SKATER_DIVIDER_GROUPS: string[][] = [["C", "L", "R", "F"], ["D"], ["UTIL"], ["BE"]];
const GOALIE_SLOT_ORDER = ["G", "BE"];
const GOALIE_DIVIDER_GROUPS: string[][] = [["G"], ["BE"]];

function slotSortRank(slot: string, order: string[]): number {
  const idx = order.indexOf(slot);
  return idx === -1 ? order.length : idx;
}

function slotGroupIndex(slot: string, groups: string[][]): number {
  const idx = groups.findIndex((g) => g.includes(slot));
  return idx === -1 ? groups.length : idx;
}

type Tab = "stats" | "schedule" | "draftpicks";

type RosterSlotWithPlayer = Awaited<ReturnType<typeof getTeamRosterView>>[number];

interface LineupInfo {
  game: TeamGameInfo | undefined;
  locked: boolean;
  currentSlot: string;
}

function formatStatCells(stats: PlayerStatsRow | undefined, columns: StatColumn[]): MoveBoardStatCell[] {
  return columns.map((col) => ({
    key: col.key,
    value: stats ? (col.format ? col.format(col.get(stats)) : String(col.get(stats))) : "—",
  }));
}

function playerBadges(player: RosterSlotWithPlayer["player"], eligible: string[], waiverGpThreshold: number): MoveBoardBadge[] {
  const badges: MoveBoardBadge[] = [];
  if (eligible.length > 0) badges.push({ label: eligible.join("/"), tone: "muted" });
  if (player.careerNhlGp >= waiverGpThreshold) {
    badges.push({
      label: `${waiverGpThreshold}+ GP`,
      tone: "warning",
      title: `${player.careerNhlGp} career GP — sending him to farm exposes him to demotion waivers`,
    });
  }
  if (player.officialRosterStatus === "IR" || player.officialRosterStatus === "LTIR") {
    badges.push({ label: player.officialRosterStatus, tone: "danger" });
  }
  return badges;
}

/** Builds one table's (Skaters or Goalies) rows for the Move UI — real
 * occupants grouped by current lineup slot plus synthetic "Empty" rows for
 * any unfilled capacity, and every eligible active player's Move
 * destinations (bench, an eligible empty slot, or swapping with an eligible
 * occupant of a full slot). `tablePrefix` keeps synthetic row keys from
 * colliding between the Skaters and Goalies tables. */
function buildTierRows(params: {
  tablePrefix: string;
  startingSlots: string[];
  dividerGroups: string[][];
  occupants: RosterSlotWithPlayer[];
  lineupFor: (s: RosterSlotWithPlayer) => LineupInfo;
  comp: RosterComposition;
  positionMode: "SEPARATE" | "COMBINED";
  statsById: Map<string, PlayerStatsRow>;
  columns: StatColumn[];
  waiverGpThreshold: number;
  farmEnabled: boolean;
}): {
  rows: MoveBoardRow[];
  moveOptions: Record<string, MoveOption[]>;
  sourceTier: Record<string, MoveSourceTier>;
  occupantsBySlot: Map<string, RosterSlotWithPlayer[]>;
} {
  const { tablePrefix, startingSlots, dividerGroups, occupants, lineupFor, comp, positionMode, statsById, columns, waiverGpThreshold, farmEnabled } =
    params;

  const occupantsBySlot = new Map<string, RosterSlotWithPlayer[]>();
  for (const slot of [...startingSlots, "BE"]) occupantsBySlot.set(slot, []);
  for (const s of occupants) {
    const slot = lineupFor(s).currentSlot;
    (occupantsBySlot.get(slot) ?? occupantsBySlot.set(slot, []).get(slot)!).push(s);
  }

  const emptyCountBySlot = new Map<string, number>();
  for (const slot of startingSlots) {
    const capN = capFor(slot, comp) ?? 0;
    emptyCountBySlot.set(slot, Math.max(0, capN - (occupantsBySlot.get(slot)?.length ?? 0)));
  }
  emptyCountBySlot.set("BE", 1); // bench is uncapped — always exactly one generic "move here" placeholder

  const rows: MoveBoardRow[] = [];
  const moveOptions: Record<string, MoveOption[]> = {};
  const sourceTier: Record<string, MoveSourceTier> = {};
  let lastGroupIdx = -1;

  for (const slot of [...startingSlots, "BE"]) {
    const slotOccupants = occupantsBySlot.get(slot) ?? [];
    const emptyCount = emptyCountBySlot.get(slot) ?? 0;
    if (slotOccupants.length === 0 && emptyCount === 0) continue;

    const groupIdx = slotGroupIndex(slot, dividerGroups);
    let firstInBatch = true;

    for (const s of slotOccupants) {
      const { player, playerId } = s;
      const lineup = lineupFor(s);
      const stats = statsById.get(playerId);
      const eligible = eligibleSlotsForPosition(player.primaryPosition, positionMode);

      rows.push({
        kind: "occupant",
        rowKey: playerId,
        slot,
        playerId,
        fullName: player.fullName,
        headshotUrl: player.headshotUrl,
        currentNhlOrg: player.currentNhlOrg,
        badges: playerBadges(player, eligible, waiverGpThreshold),
        opponentLabel: lineup.game
          ? `${lineup.game.home ? "vs" : "@"} ${lineup.game.opponent}${lineup.locked ? " · locked" : ""}`
          : "No game",
        locked: lineup.locked,
        statCells: formatStatCells(stats, columns),
        canSendToFarm: farmEnabled,
        canDrop: true,
        isGroupStart: firstInBatch && lastGroupIdx !== -1 && groupIdx !== lastGroupIdx,
      });
      firstInBatch = false;

      if (!lineup.locked) {
        const options: MoveOption[] = [];
        if (slot !== "BE") {
          options.push({ rowKey: `${tablePrefix}:empty:BE:0`, destination: { kind: "BENCH" } });
        }
        for (const targetSlot of eligible) {
          if (targetSlot === slot) continue;
          const targetOccupants = occupantsBySlot.get(targetSlot) ?? [];
          const targetCap = capFor(targetSlot, comp) ?? 0;
          const targetEmpty = Math.max(0, targetCap - targetOccupants.length);
          if (targetEmpty > 0) {
            for (let j = 0; j < targetEmpty; j++) {
              options.push({ rowKey: `${tablePrefix}:empty:${targetSlot}:${j}`, destination: { kind: "SLOT_EMPTY", slot: targetSlot } });
            }
          } else {
            for (const o of targetOccupants) {
              const oLineup = lineupFor(o);
              if (oLineup.locked) continue;
              const oEligible = eligibleSlotsForPosition(o.player.primaryPosition, positionMode);
              if (slot !== "BE" && !oEligible.includes(slot)) continue;
              options.push({ rowKey: o.playerId, destination: { kind: "SLOT_SWAP", slot: targetSlot, displacedPlayerId: o.playerId } });
            }
          }
        }
        moveOptions[playerId] = options;
        sourceTier[playerId] = "ACTIVE";
      }
    }

    for (let j = 0; j < emptyCount; j++) {
      rows.push({
        kind: "empty",
        rowKey: `${tablePrefix}:empty:${slot}:${j}`,
        slot,
        label: SLOT_LABELS[slot] ?? slot,
        isGroupStart: firstInBatch && lastGroupIdx !== -1 && groupIdx !== lastGroupIdx,
      });
      firstInBatch = false;
    }

    lastGroupIdx = groupIdx;
  }

  return { rows, moveOptions, sourceTier, occupantsBySlot };
}

export default async function TeamRosterPage(props: PageProps<"/leagues/[id]/teams/[teamId]">) {
  const { userId } = await auth.protect();
  const { id: leagueId, teamId } = await props.params;
  const sp = await props.searchParams;
  const rawDate = Array.isArray(sp.date) ? sp.date[0] : sp.date;
  const rawView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const date = rawDate && DATE_RE.test(rawDate) ? rawDate : todayUTC();
  const view = rawView ?? "daily";
  const tab: Tab = rawTab === "schedule" || rawTab === "draftpicks" ? rawTab : "stats";

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== leagueId) notFound();

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = activeRosterCap(settings);
  const isManager = isTeamManager(team, userId);
  const isPrimaryManager = team.managerUserId === userId;
  const isCommissioner = await isLeagueCommissioner(leagueId, userId);
  const isCommissionerViewing = !isManager && isCommissioner;
  const canEditBranding = isPrimaryManager || isCommissioner;

  const [primaryManagerName, coManagerName] = await Promise.all([
    getUserDisplayName(team.managerUserId),
    team.secondManagerUserId ? getUserDisplayName(team.secondManagerUserId) : Promise.resolve(null),
  ]);

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

  const fullSchedule = await getTeamSchedule(teamId, leagueId, team.league.currentSeason, settings.scoringConfig);
  const upcomingMatchups = fullSchedule.filter((r) => r.endDate >= new Date()).slice(0, 2);

  const notifications = isManager ? await getTeamNotifications(leagueId, teamId) : [];

  const draftPicks = tab === "draftpicks" ? await getTeamDraftPicks(teamId) : [];

  const allSlots = await getTeamRosterView(teamId);
  const activeSlots = allSlots.filter((s) => s.slotType === "ACTIVE");
  const farmSlots = allSlots.filter((s) => s.slotType === "FARM");
  const irSlots = allSlots.filter((s) => s.slotType === "IR");
  const playerIds = allSlots.map((s) => s.playerId);

  const [statsById, lineupEntries, teamGames, callupsUsed] = await Promise.all([
    view === "daily"
      ? getPlayerDailyStats(playerIds, date, settings.scoringConfig)
      : getPlayerStatsAggregate({
          playerIds,
          scoringConfig: settings.scoringConfig,
          dateRange: seasonByValue(view) ?? seasonByValue("2025"),
        }).then((rows) => new Map(rows.map((r) => [r.id, r] as [string, PlayerStatsRow]))),
    getLineupForDate(teamId, date),
    getTeamGamesForDate(date),
    getCallupsUsedThisWeek(teamId, leagueId),
  ]);

  const lineupBySlot = new Map(lineupEntries.map((e) => [e.playerId, e.lineupSlot]));

  function lineupFor(s: RosterSlotWithPlayer): LineupInfo {
    const currentSlot = lineupBySlot.get(s.playerId) ?? "BE";
    const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
    const locked = game ? isLocked(game) : false;
    return { game, locked, currentSlot };
  }

  // Goalies rendered in their own table below skaters — matching ESPN's team
  // page, which groups by position rather than mixing stat columns that
  // don't apply across both. Within each table, rows sort by *current lineup
  // slot* (not roster-add order) so putting a player into C moves him up
  // into the C group immediately — sort is stable, so ties keep roster order.
  const activeSkaters = activeSlots
    .filter((s) => s.player.primaryPosition !== "G")
    .sort((a, b) => slotSortRank(lineupFor(a).currentSlot, SKATER_SLOT_ORDER) - slotSortRank(lineupFor(b).currentSlot, SKATER_SLOT_ORDER));
  const activeGoalies = activeSlots
    .filter((s) => s.player.primaryPosition === "G")
    .sort((a, b) => slotSortRank(lineupFor(a).currentSlot, GOALIE_SLOT_ORDER) - slotSortRank(lineupFor(b).currentSlot, GOALIE_SLOT_ORDER));

  const weekDates = Array.from({ length: 7 }, (_, i) => shiftDate(todayUTC(), i));

  function tabHref(t: Tab): string {
    return `/leagues/${leagueId}/teams/${teamId}?tab=${t}`;
  }

  const tabClass = (t: Tab) =>
    `border-b-2 px-1 pb-2 text-sm font-medium ${
      tab === t ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"
    }`;

  const positionMode = settings.rosterComposition.positionMode;
  const irLabelNode = (
    <>
      IR ({irSlots.length} / {settings.irSlots})
    </>
  );

  // ---- Move board data (owner path only) ----
  let moveBoard: {
    skaterColumnDefs: { key: string; label: string }[];
    goalieColumnDefs: { key: string; label: string }[];
    skaterRows: MoveBoardRow[];
    goalieRows: MoveBoardRow[];
    irRows: MoveBoardIrRow[];
    moveOptionsByPlayerId: Record<string, MoveOption[]>;
    sourceTierByPlayerId: Record<string, MoveSourceTier>;
  } | null = null;

  if (isManager) {
    const skaterStartingSlots = lineupSlotsFor(positionMode).filter((s) => s !== "BE" && s !== "G");
    const goalieStartingSlots = ["G"];

    const skaterColumns = [...SKATER_COLUMNS, ...POINTS_COLUMNS];
    const goalieColumns = [...GOALIE_COLUMNS, ...POINTS_COLUMNS];

    const skaterBuild = buildTierRows({
      tablePrefix: "SK",
      startingSlots: skaterStartingSlots,
      dividerGroups: SKATER_DIVIDER_GROUPS,
      occupants: activeSkaters,
      lineupFor,
      comp: settings.rosterComposition,
      positionMode,
      statsById,
      columns: skaterColumns,
      waiverGpThreshold: settings.waiverGpThreshold,
      farmEnabled: settings.farmSlots > 0,
    });
    const goalieBuild = buildTierRows({
      tablePrefix: "G",
      startingSlots: goalieStartingSlots,
      dividerGroups: GOALIE_DIVIDER_GROUPS,
      occupants: activeGoalies,
      lineupFor,
      comp: settings.rosterComposition,
      positionMode,
      statsById,
      columns: goalieColumns,
      waiverGpThreshold: settings.waiverGpThreshold,
      farmEnabled: settings.farmSlots > 0,
    });

    const moveOptionsByPlayerId: Record<string, MoveOption[]> = { ...skaterBuild.moveOptions, ...goalieBuild.moveOptions };
    const sourceTierByPlayerId: Record<string, MoveSourceTier> = { ...skaterBuild.sourceTier, ...goalieBuild.sourceTier };

    // Healthy-active-player -> IR: attach as an extra destination onto
    // whichever table that player already has options in (or start a fresh
    // list if his own game is locked, since IR placement doesn't require
    // his lineup slot to be editable).
    const irCap = settings.irSlots;
    const irEmptyCount = Math.max(0, irCap - irSlots.length);
    for (const s of activeSlots) {
      const isIrEligible = s.player.officialRosterStatus === "IR" || s.player.officialRosterStatus === "LTIR";
      if (!isIrEligible || irEmptyCount === 0) continue;
      const existing = moveOptionsByPlayerId[s.playerId];
      if (!existing) continue; // his own game is locked — can't be moved at all right now
      existing.push({ rowKey: "IR:empty:0", destination: { kind: "IR_PLACE" } });
    }

    // IR list — activation destinations reference the tables' own occupant/
    // empty data built above.
    const irRows: MoveBoardIrRow[] = [];
    const activeFull = activeSlots.length >= cap;
    for (const s of irSlots) {
      const stillIr = s.player.officialRosterStatus === "IR" || s.player.officialRosterStatus === "LTIR";
      const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
      const locked = game ? isLocked(game) : false;
      const disabledReason = stillIr
        ? "Still officially on IR"
        : activeFull
          ? "Active roster full — send someone down first"
          : locked
            ? "Game already started"
            : null;

      if (!disabledReason) {
        const isGoalie = s.player.primaryPosition === "G";
        const build = isGoalie ? goalieBuild : skaterBuild;
        const tablePrefix = isGoalie ? "G" : "SK";
        const eligible = eligibleSlotsForPosition(s.player.primaryPosition, positionMode);
        const options: MoveOption[] = [{ rowKey: `${tablePrefix}:empty:BE:0`, destination: { kind: "IR_ACTIVATE_BENCH" } }];
        for (const targetSlot of eligible) {
          const targetOccupants = build.occupantsBySlot.get(targetSlot) ?? [];
          const targetCap = capFor(targetSlot, settings.rosterComposition) ?? 0;
          const targetEmpty = Math.max(0, targetCap - targetOccupants.length);
          if (targetEmpty > 0) {
            for (let j = 0; j < targetEmpty; j++) {
              options.push({ rowKey: `${tablePrefix}:empty:${targetSlot}:${j}`, destination: { kind: "IR_ACTIVATE_EMPTY", slot: targetSlot } });
            }
          } else {
            for (const o of targetOccupants) {
              if (lineupFor(o).locked) continue;
              options.push({ rowKey: o.playerId, destination: { kind: "IR_ACTIVATE_SWAP", slot: targetSlot, displacedPlayerId: o.playerId } });
            }
          }
        }
        moveOptionsByPlayerId[s.playerId] = options;
        sourceTierByPlayerId[s.playerId] = "IR";
      }

      irRows.push({
        kind: "occupant",
        rowKey: s.playerId,
        playerId: s.playerId,
        fullName: s.player.fullName,
        headshotUrl: s.player.headshotUrl,
        currentNhlOrg: s.player.currentNhlOrg,
        officialRosterStatus: s.player.officialRosterStatus,
        disabledReason,
      });
    }
    if (irEmptyCount > 0) {
      irRows.push({ kind: "empty", rowKey: "IR:empty:0" });
    }

    moveBoard = {
      skaterColumnDefs: skaterColumns.map((c) => ({ key: c.key, label: c.label })),
      goalieColumnDefs: goalieColumns.map((c) => ({ key: c.key, label: c.label })),
      skaterRows: skaterBuild.rows,
      goalieRows: goalieBuild.rows,
      irRows,
      moveOptionsByPlayerId,
      sourceTierByPlayerId,
    };
  }

  const farmSectionNode = (
    <div key="farm" className="mt-6">
      <SectionLabel>
        Farm ({farmSlots.length} / {settings.farmSlots})
        {isManager && (
          <span className="ml-2 normal-case text-muted">
            · {callupsUsed} / {settings.callupsPerWeek} callups used this week
          </span>
        )}
      </SectionLabel>
      {farmSlots.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No players on the farm.</p>
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <ul className="divide-y divide-border">
            {farmSlots.map((s) => {
              const stats = statsById.get(s.playerId);
              const played = stats && stats.gamesIngested > 0;
              const activeFull = activeSlots.length >= cap;
              const callupLimitReached = callupsUsed >= settings.callupsPerWeek;
              return (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                    {s.player.fullName}
                    <span className="text-xs text-muted">
                      {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                    </span>
                    {s.waiverExpiresAt && s.waiverExpiresAt > new Date() && (
                      <Badge tone="warning" title="Another team can claim him until this passes — see the Waivers page" className="ml-2 normal-case">
                        claimable until {s.waiverExpiresAt.toLocaleString()}
                      </Badge>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    {played && (
                      <span className="text-xs text-muted">
                        {stats.gamesIngested} GP · {stats.points.toFixed(1)} pts
                      </span>
                    )}
                    {isManager && (
                      <form action={callUpAction.bind(null, leagueId, teamId, s.playerId)}>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={activeFull || callupLimitReached}
                          title={
                            activeFull
                              ? "Active roster is full"
                              : callupLimitReached
                                ? "Weekly callup limit reached"
                                : undefined
                          }
                        >
                          ↑ Call Up
                        </Button>
                      </form>
                    )}
                    {!isManager && isCommissionerViewing && (
                      <span className="flex items-center gap-1.5">
                        <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, s.playerId, "ACTIVE")}>
                          <Button type="submit" size="sm">→ Active</Button>
                        </form>
                        <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, s.playerId, "IR")}>
                          <Button type="submit" size="sm">→ IR</Button>
                        </form>
                        <form action={commissionerDropPlayerAction.bind(null, leagueId, teamId, s.playerId)}>
                          <Button type="submit" variant="danger" size="sm">− Drop</Button>
                        </form>
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-muted hover:underline">
        ← {team.league.name}
      </Link>

      <Card className="mt-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <TeamLogo url={team.logoUrl} alt={team.name} size={56} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
                <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "Redraft" : "Dynasty"}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">
                Managed by {primaryManagerName}
                {coManagerName && <> &amp; {coManagerName}</>}
              </p>
              <p className="mt-1 text-sm text-muted">
                {activeSlots.length} / {cap} active roster spots
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isManager && (
              <>
                <LinkButton href={`/leagues/${leagueId}/trades`} variant="primary">Propose Trade</LinkButton>
                <LinkButton href={`/leagues/${leagueId}/players`}>+ Add</LinkButton>
              </>
            )}
          </div>
        </div>

        {canEditBranding && (
          <div className="mt-3 border-t border-border pt-3">
            <LogoUploadForm leagueId={leagueId} teamId={teamId} />
          </div>
        )}

        {isPrimaryManager && (
          <div className="mt-3 border-t border-border pt-3 text-sm">
            {team.secondManagerUserId ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted">Co-manager: {coManagerName}</span>
                <ConfirmActionButton
                  action={removeCoManagerAction.bind(null, leagueId, teamId)}
                  confirmText={`Remove ${coManagerName} as co-manager of ${team.name}?`}
                  label="Remove co-manager"
                  size="sm"
                />
              </div>
            ) : team.secondManagerClaimCode ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Share this link to invite a co-manager:</span>
                <p className="select-all rounded border border-border bg-surface-tint px-2 py-1 text-xs">
                  {origin}/invite/team/co-manager/{team.secondManagerClaimCode}
                </p>
                <form action={regenerateCoManagerClaimCodeAction.bind(null, leagueId, teamId)}>
                  <Button type="submit" size="sm">Regenerate link</Button>
                </form>
              </div>
            ) : (
              <form action={regenerateCoManagerClaimCodeAction.bind(null, leagueId, teamId)}>
                <Button type="submit" size="sm">Invite a co-manager</Button>
              </form>
            )}
          </div>
        )}
      </Card>

      {notifications.length > 0 && (
        <div className="mt-4">
          <SectionLabel>Notifications</SectionLabel>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {notifications.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${NOTIFICATION_DOT[n.kind]}`} />
                    {n.text}
                  </span>
                  <Link href={n.href} className="shrink-0 text-xs text-blue hover:underline">
                    View →
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {fullSchedule.length > 0 && (
        <div className="mt-4">
          <SectionLabel>Schedule</SectionLabel>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4">
                {upcomingMatchups.length === 0 && <span className="text-sm text-muted">Season complete.</span>}
                {upcomingMatchups.map((m) => (
                  <span key={m.periodNo} className="text-sm">
                    <span className="text-xs text-muted">
                      {m.isPlayoffs ? m.roundLabel : `Week ${m.periodNo}`}
                      {" · "}
                      {m.startDate.toISOString().slice(0, 10)}
                    </span>
                    <br />
                    {m.bye ? (
                      <span className="text-muted">Bye</span>
                    ) : (
                      <>
                        {m.isHome ? "vs" : "@"}{" "}
                        <Link href={`/leagues/${leagueId}/teams/${m.opponentTeamId}`} className="font-medium hover:underline">
                          {m.opponentTeamName}
                        </Link>
                      </>
                    )}
                  </span>
                ))}
              </div>
              <LinkButton href={`/leagues/${leagueId}/teams/${teamId}?tab=schedule`} size="sm">
                My Schedule →
              </LinkButton>
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6 flex gap-5 border-b border-border">
        <Link href={tabHref("stats")} className={tabClass("stats")}>
          Stats
        </Link>
        <Link href={tabHref("schedule")} className={tabClass("schedule")}>
          Schedule
        </Link>
        <Link href={tabHref("draftpicks")} className={tabClass("draftpicks")}>
          Draft Picks
        </Link>
      </div>

      {tab === "schedule" && (
        <div className="mt-6">
          <TeamScheduleList leagueId={leagueId} rows={fullSchedule} />
        </div>
      )}

      {tab === "draftpicks" && (
        <div className="mt-6">
          {draftPicks.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">No draft picks owned.</p>
            </Card>
          ) : (
            <Card className="!p-0 overflow-hidden">
              <ul className="divide-y divide-border">
                {draftPicks.map((p) => (
                  <li key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <span>
                      <span className="font-medium">
                        {p.season} Round {p.round}
                      </span>
                      {!p.isOwnPick && <span className="ml-2 text-xs text-muted">via trade from {p.originalTeamName}</span>}
                    </span>
                    {p.used ? (
                      <span className="text-xs text-muted">used on {p.usedOnPlayerName}</span>
                    ) : (
                      <span className="text-xs text-muted">unused</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === "stats" && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            {view === "daily" ? (
              <DateStrip leagueId={leagueId} teamId={teamId} selectedDate={date} view={view} />
            ) : (
              <span className="text-sm text-muted">Season aggregate — {date === todayUTC() ? "Today" : date}</span>
            )}
            <ViewControls leagueId={leagueId} teamId={teamId} date={date} view={view} />
          </div>
          {isManager && (
            <div className="mt-3 flex items-center gap-2">
              <AutoSetLineupButton
                leagueId={leagueId}
                teamId={teamId}
                dates={[todayUTC()]}
                label="Auto-Set Today"
                confirmText="Auto-set today's lineup? This replaces any manual picks for unlocked players with the best-ranked eligible starters."
              />
              <AutoSetLineupButton
                leagueId={leagueId}
                teamId={teamId}
                dates={weekDates}
                label="Auto-Set This Week"
                confirmText="Auto-set this week's lineup (today through the next 6 days)? This replaces any manual picks for unlocked players with the best-ranked eligible starters."
              />
            </div>
          )}
          <p className="mt-1 text-xs text-muted">
            Lineups are freely editable until a player&apos;s own game starts.
          </p>

          {isCommissionerViewing && (
            <div className="mt-6">
              <SectionLabel>Commissioner controls</SectionLabel>
              <Card>
                <p className="mb-2 text-xs text-muted">
                  Full override — bypasses roster cap, waiver exemption, and FAAB checks.
                </p>
                <CommissionerAddPlayerBox leagueId={leagueId} teamId={teamId} />
              </Card>
            </div>
          )}

          {isManager && moveBoard ? (
            <RosterMoveBoard
              leagueId={leagueId}
              teamId={teamId}
              date={date}
              skaterColumnDefs={moveBoard.skaterColumnDefs}
              goalieColumnDefs={moveBoard.goalieColumnDefs}
              skaterRows={moveBoard.skaterRows}
              goalieRows={moveBoard.goalieRows}
              irRows={moveBoard.irRows}
              irLabel={irLabelNode}
              moveOptionsByPlayerId={moveBoard.moveOptionsByPlayerId}
              sourceTierByPlayerId={moveBoard.sourceTierByPlayerId}
              farmSection={farmSectionNode}
              activeCap={cap}
            />
          ) : (
            <>
              <div className="mt-6">
                <SectionLabel>Skaters</SectionLabel>
                <RosterTable
                  slots={activeSkaters}
                  slotGroups={SKATER_DIVIDER_GROUPS}
                  statsById={statsById}
                  columns={SKATER_COLUMNS}
                  leagueId={leagueId}
                  teamId={teamId}
                  isCommissionerViewing={isCommissionerViewing}
                  lineupFor={lineupFor}
                  waiverGpThreshold={settings.waiverGpThreshold}
                  positionMode={settings.rosterComposition.positionMode}
                  emptyText="No skaters rostered yet."
                />
              </div>

              <div className="mt-6">
                <SectionLabel>Goalies</SectionLabel>
                <RosterTable
                  slots={activeGoalies}
                  slotGroups={GOALIE_DIVIDER_GROUPS}
                  statsById={statsById}
                  columns={GOALIE_COLUMNS}
                  leagueId={leagueId}
                  teamId={teamId}
                  isCommissionerViewing={isCommissionerViewing}
                  lineupFor={lineupFor}
                  waiverGpThreshold={settings.waiverGpThreshold}
                  positionMode={settings.rosterComposition.positionMode}
                  emptyText="No goalies rostered yet."
                />
              </div>

              {farmSectionNode}

              <div className="mt-6">
                <SectionLabel>{irLabelNode}</SectionLabel>
                {irSlots.length === 0 ? (
                  <Card>
                    <p className="text-sm text-muted">No players on IR.</p>
                  </Card>
                ) : (
                  <Card className="!p-0 overflow-hidden">
                    <ul className="divide-y divide-border">
                      {irSlots.map((s) => (
                        <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                            {s.player.fullName}
                            <span className="text-xs text-muted">
                              {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                            </span>
                            <Badge tone="muted">{s.player.officialRosterStatus ?? "IR"}</Badge>
                          </span>
                          {isCommissionerViewing && (
                            <span className="flex items-center gap-1.5">
                              <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, s.playerId, "ACTIVE")}>
                                <Button type="submit" size="sm">→ Active</Button>
                              </form>
                              <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, s.playerId, "FARM")}>
                                <Button type="submit" size="sm">→ Farm</Button>
                              </form>
                              <form action={commissionerDropPlayerAction.bind(null, leagueId, teamId, s.playerId)}>
                                <Button type="submit" variant="danger" size="sm">− Drop</Button>
                              </form>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Non-owner rendering only now (plain viewer, or commissioner viewing
 * someone else's team) — the owner path renders through RosterMoveBoard
 * instead. No lineup-slot editing control here since neither viewer role
 * can edit a lineup that isn't theirs. */
function RosterTable({
  slots,
  slotGroups,
  statsById,
  columns,
  leagueId,
  teamId,
  isCommissionerViewing,
  lineupFor,
  waiverGpThreshold,
  positionMode,
  emptyText,
}: {
  slots: RosterSlotWithPlayer[];
  slotGroups: string[][];
  statsById: Map<string, PlayerStatsRow>;
  columns: StatColumn[];
  leagueId: string;
  teamId: string;
  isCommissionerViewing: boolean;
  lineupFor: (s: RosterSlotWithPlayer) => LineupInfo;
  waiverGpThreshold: number;
  positionMode: "SEPARATE" | "COMBINED";
  emptyText: string;
}) {
  if (slots.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">{emptyText}</p>
      </Card>
    );
  }

  const allColumns = [...columns, ...POINTS_COLUMNS];

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pl-4 pr-2 font-medium">Player</th>
            <th className="py-2 pr-2 font-medium">Opponent</th>
            <th className="py-2 pr-2 font-medium">Status</th>
            {allColumns.map((col) => (
              <th key={col.key} className="py-2 pr-2 text-right font-medium">
                {col.label}
              </th>
            ))}
            {isCommissionerViewing && <th className="py-2 pr-4" />}
          </tr>
        </thead>
        <tbody>
          {slots.map((s, i) => {
            const { player, playerId } = s;
            const stats = statsById.get(playerId);
            const lineup = lineupFor(s);
            const eligible = eligibleSlotsForPosition(player.primaryPosition, positionMode);

            const group = slotGroupIndex(lineup.currentSlot, slotGroups);
            const prevGroup = i > 0 ? slotGroupIndex(lineupFor(slots[i - 1]).currentSlot, slotGroups) : group;
            const isGroupStart = i > 0 && group !== prevGroup;

            return (
              <tr
                key={playerId}
                className={`border-b border-border last:border-0 ${
                  i % 2 === 1 ? "bg-surface-tint" : ""
                } ${isGroupStart ? "border-t-2 border-t-blue" : ""}`}
              >
                <td className="py-2 pl-4 pr-2 font-medium">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={player.headshotUrl} alt={player.fullName} size={28} />
                    {player.fullName}
                    {eligible.length > 0 && <Badge tone="muted">{eligible.join("/")}</Badge>}
                    {player.careerNhlGp >= waiverGpThreshold && (
                      <Badge tone="warning" title={`${player.careerNhlGp} career GP — sending him to farm exposes him to demotion waivers`}>
                        {waiverGpThreshold}+ GP
                      </Badge>
                    )}
                    {(player.officialRosterStatus === "IR" || player.officialRosterStatus === "LTIR") && (
                      <Badge tone="danger">{player.officialRosterStatus}</Badge>
                    )}
                    <span className="text-xs text-muted">{player.currentNhlOrg ?? "—"}</span>
                  </span>
                </td>
                <td className="py-2 pr-2 text-muted">
                  {lineup?.game
                    ? `${lineup.game.home ? "vs" : "@"} ${lineup.game.opponent}${lineup.locked ? " · locked" : ""}`
                    : "No game"}
                </td>
                <td className="py-2 pr-2">
                  <span className="text-xs text-muted">
                    {lineup.currentSlot === "BE" ? "Bench" : lineup.currentSlot}
                  </span>
                </td>
                {allColumns.map((col) => (
                  <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                    {stats ? (col.format ? col.format(col.get(stats)) : col.get(stats)) : "—"}
                  </td>
                ))}
                {isCommissionerViewing && (
                  <td className="py-2 pr-4 text-right">
                    <div className="flex justify-end gap-1.5">
                      {s.slotType !== "ACTIVE" && (
                        <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, playerId, "ACTIVE")}>
                          <Button type="submit" size="sm">→ Active</Button>
                        </form>
                      )}
                      {s.slotType !== "FARM" && (
                        <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, playerId, "FARM")}>
                          <Button type="submit" size="sm">→ Farm</Button>
                        </form>
                      )}
                      {s.slotType !== "IR" && (
                        <form action={commissionerMovePlayerAction.bind(null, leagueId, teamId, playerId, "IR")}>
                          <Button type="submit" size="sm">→ IR</Button>
                        </form>
                      )}
                      <form action={commissionerDropPlayerAction.bind(null, leagueId, teamId, playerId)}>
                        <Button type="submit" variant="danger" size="sm">− Drop</Button>
                      </form>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
