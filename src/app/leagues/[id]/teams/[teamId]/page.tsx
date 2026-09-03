import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView, getCallupsUsedThisWeek } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate, getPlayerDailyStats, type PlayerStatsRow } from "@/lib/players/rankings";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import { seasonByValue } from "@/lib/players/seasons";
import { getLineupForDate, capFor, eligibleSlotsForPosition } from "@/lib/lineups/mutations";
import { getTeamGamesForDate, isLocked, type TeamGameInfo } from "@/lib/lineups/schedule";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { dropPlayerAction, sendToFarmAction, callUpAction, placeOnIrAction, activateFromIrAction } from "./actions";
import { LineupSlotSelect, type SlotOption } from "./LineupSlotSelect";
import { ViewControls } from "./ViewControls";
import { AutoSetLineupButton } from "./AutoSetLineupButton";

const SLOT_LABELS: Record<string, string> = { C: "C", L: "L", R: "R", D: "D", G: "G", UTIL: "UTIL", BE: "Bench" };

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Row ordering for the ESPN-style layout: players sort into their current
// lineup slot (not roster-add order) — C block, then L, then R, then D, then
// UTIL, then Bench. A visual divider is coarser than the sort: C/L/R don't
// get a line between them, only before D / UTIL / Bench do.
const SKATER_SLOT_ORDER = ["C", "L", "R", "D", "UTIL", "BE"];
const SKATER_DIVIDER_GROUPS: string[][] = [["C", "L", "R"], ["D"], ["UTIL"], ["BE"]];
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

export default async function TeamRosterPage(props: PageProps<"/leagues/[id]/teams/[teamId]">) {
  const { userId } = await auth.protect();
  const { id: leagueId, teamId } = await props.params;
  const sp = await props.searchParams;
  const rawDate = Array.isArray(sp.date) ? sp.date[0] : sp.date;
  const rawView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const date = rawDate && DATE_RE.test(rawDate) ? rawDate : todayUTC();
  const view = rawView ?? "daily";

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { league: true },
  });
  if (!team || team.leagueId !== leagueId) notFound();

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const cap = Object.values(settings.rosterComposition).reduce((sum, n) => sum + n, 0);
  const isOwner = team.managerUserId === userId;

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
  const occupiedCount = new Map<string, number>();
  for (const e of lineupEntries) {
    occupiedCount.set(e.lineupSlot, (occupiedCount.get(e.lineupSlot) ?? 0) + 1);
  }

  function lineupFor(s: (typeof activeSlots)[number]) {
    const currentSlot = lineupBySlot.get(s.playerId) ?? "BE";
    const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
    const locked = game ? isLocked(game) : false;

    const starterSlots = eligibleSlotsForPosition(s.player.primaryPosition);
    const options: SlotOption[] = [
      ...starterSlots.map((slot) => {
        const capN = capFor(slot, settings.rosterComposition) ?? 0;
        const occupied = (occupiedCount.get(slot) ?? 0) - (currentSlot === slot ? 1 : 0);
        return {
          value: slot,
          label: `${SLOT_LABELS[slot]} (${Math.min(occupied + (currentSlot === slot ? 1 : 0), capN)}/${capN})`,
          disabled: occupied >= capN,
        };
      }),
      { value: "BE", label: "Bench", disabled: false },
    ];

    return { game, locked, currentSlot, options };
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-zinc-500 hover:underline">
        ← {team.league.name}
      </Link>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {activeSlots.length} / {cap} active roster spots
          </p>
        </div>
        {isOwner && (
          <Link
            href={`/leagues/${leagueId}/players`}
            className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            + Add
          </Link>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        <div className="flex items-center gap-2">
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}?date=${shiftDate(date, -1)}&view=${view}`}
            className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            ← Prev
          </Link>
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}?date=${shiftDate(date, 1)}&view=${view}`}
            className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            Next →
          </Link>
          {date !== todayUTC() && (
            <Link
              href={`/leagues/${leagueId}/teams/${teamId}?date=${todayUTC()}&view=${view}`}
              className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
            >
              Today
            </Link>
          )}
          <span className="text-sm text-zinc-500">{date === todayUTC() ? "Today" : date}</span>
        </div>
        <ViewControls leagueId={leagueId} teamId={teamId} date={date} view={view} />
      </div>
      {isOwner && (
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
      <p className="mt-1 text-xs text-zinc-500">
        Lineups are freely editable until a player&apos;s own game starts.
      </p>

      <div className="mt-6">
        <SectionLabel>Skaters</SectionLabel>
        <RosterTable
          slots={activeSkaters}
          slotGroups={SKATER_DIVIDER_GROUPS}
          statsById={statsById}
          columns={SKATER_COLUMNS}
          leagueId={leagueId}
          teamId={teamId}
          date={date}
          isOwner={isOwner}
          lineupFor={lineupFor}
          waiverGpThreshold={settings.waiverGpThreshold}
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
          date={date}
          isOwner={isOwner}
          lineupFor={lineupFor}
          waiverGpThreshold={settings.waiverGpThreshold}
          emptyText="No goalies rostered yet."
        />
      </div>

      <div className="mt-6">
        <SectionLabel>
          Farm ({farmSlots.length} / {settings.farmSlots})
          {isOwner && (
            <span className="ml-2 normal-case text-zinc-400">
              · {callupsUsed} / {settings.callupsPerWeek} callups used this week
            </span>
          )}
        </SectionLabel>
        {farmSlots.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">No players on the farm.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {farmSlots.map((s) => {
                const stats = statsById.get(s.playerId);
                const played = stats && stats.gamesIngested > 0;
                const activeFull = activeSlots.length >= cap;
                const callupLimitReached = callupsUsed >= settings.callupsPerWeek;
                return (
                  <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      {s.player.fullName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                      </span>
                      {s.waiverExpiresAt && s.waiverExpiresAt > new Date() && (
                        <span
                          title="Another team can claim him until this passes — see the Waivers page"
                          className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                        >
                          claimable until {s.waiverExpiresAt.toLocaleString()}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-3">
                      {played && (
                        <span className="text-xs text-zinc-500">
                          {stats.gamesIngested} GP · {stats.points.toFixed(1)} pts
                        </span>
                      )}
                      {isOwner && (
                        <form action={callUpAction.bind(null, leagueId, teamId, s.playerId)}>
                          <button
                            type="submit"
                            disabled={activeFull || callupLimitReached}
                            title={
                              activeFull
                                ? "Active roster is full"
                                : callupLimitReached
                                  ? "Weekly callup limit reached"
                                  : undefined
                            }
                            className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] disabled:opacity-30 dark:border-white/15 dark:hover:bg-white/[.05]"
                          >
                            ↑ Call Up
                          </button>
                        </form>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      <div className="mt-6">
        <SectionLabel>IR ({irSlots.length} / {settings.irSlots})</SectionLabel>
        {irSlots.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">No players on IR.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {irSlots.map((s) => {
                const stillIr = s.player.officialRosterStatus === "IR" || s.player.officialRosterStatus === "LTIR";
                const activeFull = activeSlots.length >= cap;
                return (
                  <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      {s.player.fullName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                      </span>
                      <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/10">
                        {s.player.officialRosterStatus ?? "IR"}
                      </span>
                    </span>
                    {isOwner && (
                      <form action={activateFromIrAction.bind(null, leagueId, teamId, s.playerId)}>
                        <button
                          type="submit"
                          disabled={stillIr || activeFull}
                          title={
                            stillIr
                              ? "Still officially on IR"
                              : activeFull
                                ? "Active roster is full — send someone down first"
                                : undefined
                          }
                          className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] disabled:opacity-30 dark:border-white/15 dark:hover:bg-white/[.05]"
                        >
                          Activate
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

type RosterSlotWithPlayer = Awaited<ReturnType<typeof getTeamRosterView>>[number];

interface LineupInfo {
  game: TeamGameInfo | undefined;
  locked: boolean;
  currentSlot: string;
  options: SlotOption[];
}

function RosterTable({
  slots,
  slotGroups,
  statsById,
  columns,
  leagueId,
  teamId,
  date,
  isOwner,
  lineupFor,
  waiverGpThreshold,
  emptyText,
}: {
  slots: RosterSlotWithPlayer[];
  slotGroups: string[][];
  statsById: Map<string, PlayerStatsRow>;
  columns: StatColumn[];
  leagueId: string;
  teamId: string;
  date: string;
  isOwner: boolean;
  lineupFor: (s: RosterSlotWithPlayer) => LineupInfo;
  waiverGpThreshold: number;
  emptyText: string;
}) {
  if (slots.length === 0) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">{emptyText}</p>
      </Card>
    );
  }

  const allColumns = [...columns, ...POINTS_COLUMNS];

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
            <th className="py-2 pl-4 pr-2 font-medium">Player</th>
            <th className="py-2 pr-2 font-medium">Opponent</th>
            <th className="py-2 pr-2 font-medium">Status</th>
            {allColumns.map((col) => (
              <th key={col.key} className="py-2 pr-2 text-right font-medium">
                {col.label}
              </th>
            ))}
            {isOwner && <th className="py-2 pr-4" />}
          </tr>
        </thead>
        <tbody>
          {slots.map((s, i) => {
            const { player, playerId } = s;
            const stats = statsById.get(playerId);
            const lineup = lineupFor(s);
            const eligible = eligibleSlotsForPosition(player.primaryPosition);

            const group = slotGroupIndex(lineup.currentSlot, slotGroups);
            const prevGroup = i > 0 ? slotGroupIndex(lineupFor(slots[i - 1]).currentSlot, slotGroups) : group;
            const isGroupStart = i > 0 && group !== prevGroup;

            return (
              <tr
                key={playerId}
                className={`border-b border-black/5 last:border-0 dark:border-white/5 ${
                  i % 2 === 1 ? "bg-black/[.015] dark:bg-white/[.02]" : ""
                } ${isGroupStart ? "border-t-2 border-t-black/20 dark:border-t-white/20" : ""}`}
              >
                <td className="py-2 pl-4 pr-2 font-medium">
                  {player.fullName}
                  {eligible.length > 0 && (
                    <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/10">
                      {eligible.join("/")}
                    </span>
                  )}
                  {player.careerNhlGp >= waiverGpThreshold && (
                    <span
                      title={`${player.careerNhlGp} career GP — sending him to farm exposes him to demotion waivers`}
                      className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                    >
                      {waiverGpThreshold}+ GP
                    </span>
                  )}
                  {(player.officialRosterStatus === "IR" || player.officialRosterStatus === "LTIR") && (
                    <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                      {player.officialRosterStatus}
                    </span>
                  )}
                  <span className="ml-2 text-xs text-zinc-500">{player.currentNhlOrg ?? "—"}</span>
                </td>
                <td className="py-2 pr-2 text-zinc-500">
                  {lineup?.game
                    ? `${lineup.game.home ? "vs" : "@"} ${lineup.game.opponent}${lineup.locked ? " · locked" : ""}`
                    : "No game"}
                </td>
                <td className="py-2 pr-2">
                  {lineup &&
                    (isOwner ? (
                      <LineupSlotSelect
                        leagueId={leagueId}
                        teamId={teamId}
                        playerId={playerId}
                        date={date}
                        value={lineup.currentSlot}
                        options={lineup.options}
                        locked={lineup.locked}
                      />
                    ) : (
                      <span className="text-xs text-zinc-500">
                        {lineup.currentSlot === "BE" ? "Bench" : lineup.currentSlot}
                      </span>
                    ))}
                </td>
                {allColumns.map((col) => (
                  <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                    {stats ? (col.format ? col.format(col.get(stats)) : col.get(stats)) : "—"}
                  </td>
                ))}
                {isOwner && (
                  <td className="py-2 pr-4 text-right">
                    <div className="flex justify-end gap-1.5">
                      {(player.officialRosterStatus === "IR" || player.officialRosterStatus === "LTIR") && (
                        <form action={placeOnIrAction.bind(null, leagueId, teamId, playerId)}>
                          <button
                            type="submit"
                            className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                          >
                            → IR
                          </button>
                        </form>
                      )}
                      <form action={sendToFarmAction.bind(null, leagueId, teamId, playerId)}>
                        <button
                          type="submit"
                          className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                        >
                          → Farm
                        </button>
                      </form>
                      <form action={dropPlayerAction.bind(null, leagueId, teamId, playerId)}>
                        <button
                          type="submit"
                          className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                        >
                          − Drop
                        </button>
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
