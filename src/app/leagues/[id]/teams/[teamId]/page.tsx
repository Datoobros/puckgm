import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { dropPlayerAction } from "./actions";

export default async function TeamRosterPage(props: PageProps<"/leagues/[id]/teams/[teamId]">) {
  const { userId } = await auth.protect();
  const { id: leagueId, teamId } = await props.params;

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

  const statsRows = await getPlayerStatsAggregate({
    playerIds: allSlots.map((s) => s.playerId),
    scoringConfig: settings.scoringConfig,
  });
  const statsById = new Map(statsRows.map((r) => [r.id, r]));

  // Goalies rendered in their own table below skaters — matching ESPN's team
  // page, which groups by position rather than mixing stat columns that
  // don't apply across both.
  const activeSkaters = activeSlots.filter((s) => s.player.primaryPosition !== "G");
  const activeGoalies = activeSlots.filter((s) => s.player.primaryPosition === "G");

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-zinc-500 hover:underline">
        ← {team.league.name}
      </Link>
      <div className="mt-1 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {activeSlots.length} / {cap} active roster spots
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}/lineup`}
            className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            Lineup
          </Link>
          {isOwner && (
            <Link
              href={`/leagues/${leagueId}/players`}
              className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
            >
              + Add
            </Link>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SectionLabel>Skaters</SectionLabel>
        <StatsTable
          players={activeSkaters.map((s) => ({ player: s.player, playerId: s.playerId }))}
          statsById={statsById}
          columns={SKATER_COLUMNS}
          leagueId={leagueId}
          teamId={teamId}
          isOwner={isOwner}
          emptyText="No skaters rostered yet."
        />
      </div>

      <div className="mt-6">
        <SectionLabel>Goalies</SectionLabel>
        <StatsTable
          players={activeGoalies.map((s) => ({ player: s.player, playerId: s.playerId }))}
          statsById={statsById}
          columns={GOALIE_COLUMNS}
          leagueId={leagueId}
          teamId={teamId}
          isOwner={isOwner}
          emptyText="No goalies rostered yet."
        />
      </div>

      <div className="mt-6">
        <SectionLabel>Farm ({farmSlots.length} / {settings.farmSlots})</SectionLabel>
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
                return (
                  <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      {s.player.fullName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                      </span>
                    </span>
                    {played && (
                      <span className="text-xs text-zinc-500">
                        {stats.gamesIngested} GP · {stats.points.toFixed(1)} pts
                      </span>
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

interface RosterPlayer {
  player: { id: string; fullName: string; primaryPosition: string | null; currentNhlOrg: string | null };
  playerId: string;
}

function StatsTable({
  players,
  statsById,
  columns,
  leagueId,
  teamId,
  isOwner,
  emptyText,
}: {
  players: RosterPlayer[];
  statsById: Map<string, PlayerStatsRow>;
  columns: StatColumn[];
  leagueId: string;
  teamId: string;
  isOwner: boolean;
  emptyText: string;
}) {
  if (players.length === 0) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">{emptyText}</p>
      </Card>
    );
  }

  const allColumns = [...columns, ...POINTS_COLUMNS];

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
            <th className="py-2 pl-4 pr-2 font-medium">Player</th>
            <th className="py-2 pr-2 font-medium">Team</th>
            {allColumns.map((col) => (
              <th key={col.key} className="py-2 pr-2 text-right font-medium">
                {col.label}
              </th>
            ))}
            {isOwner && <th className="py-2 pr-4" />}
          </tr>
        </thead>
        <tbody>
          {players.map(({ player, playerId }, i) => {
            const stats = statsById.get(playerId);
            return (
              <tr
                key={playerId}
                className={`border-b border-black/5 last:border-0 dark:border-white/5 ${
                  i % 2 === 1 ? "bg-black/[.015] dark:bg-white/[.02]" : ""
                }`}
              >
                <td className="py-2 pl-4 pr-2 font-medium">{player.fullName}</td>
                <td className="py-2 pr-2 text-zinc-500">
                  {player.primaryPosition ?? "—"} · {player.currentNhlOrg ?? "—"}
                </td>
                {allColumns.map((col) => (
                  <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                    {stats ? (col.format ? col.format(col.get(stats)) : col.get(stats)) : "—"}
                  </td>
                ))}
                {isOwner && (
                  <td className="py-2 pr-4 text-right">
                    <form action={dropPlayerAction.bind(null, leagueId, teamId, playerId)}>
                      <button
                        type="submit"
                        className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                      >
                        − Drop
                      </button>
                    </form>
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
