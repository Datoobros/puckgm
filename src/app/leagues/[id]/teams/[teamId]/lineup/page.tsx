import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import { getLineupForDate, capFor, eligibleSlotsForPosition } from "@/lib/lineups/mutations";
import { getTeamGamesForDate, isLocked } from "@/lib/lineups/schedule";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { LineupSlotSelect, type SlotOption } from "./LineupSlotSelect";
import { DateJump } from "./DateJump";

const SLOT_LABELS: Record<string, string> = {
  C: "C",
  LW: "LW",
  RW: "RW",
  D: "D",
  G: "G",
  UTIL: "UTIL",
  BE: "Bench",
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function LineupPage(props: PageProps<"/leagues/[id]/teams/[teamId]/lineup">) {
  const { userId } = await auth.protect();
  const { id: leagueId, teamId } = await props.params;
  const sp = await props.searchParams;
  const rawDate = Array.isArray(sp.date) ? sp.date[0] : sp.date;
  const date = rawDate && DATE_RE.test(rawDate) ? rawDate : todayUTC();

  const team = await prisma.team.findUnique({ where: { id: teamId }, include: { league: true } });
  if (!team || team.leagueId !== leagueId) notFound();

  const isOwner = team.managerUserId === userId;
  const settings = team.league.settingsJson as unknown as LeagueSettings;

  const [allSlots, lineupEntries, teamGames] = await Promise.all([
    getTeamRosterView(teamId),
    getLineupForDate(teamId, date),
    getTeamGamesForDate(date),
  ]);

  const activeSlots = allSlots.filter((s) => s.slotType === "ACTIVE");
  const lineupBySlot = new Map(lineupEntries.map((e) => [e.playerId, e.lineupSlot]));

  const occupiedCount = new Map<string, number>();
  for (const e of lineupEntries) {
    occupiedCount.set(e.lineupSlot, (occupiedCount.get(e.lineupSlot) ?? 0) + 1);
  }

  const rows = activeSlots.map((s) => {
    const currentSlot = lineupBySlot.get(s.playerId) ?? "BE";
    const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
    const locked = game ? isLocked(game) : false;

    const starterSlots = eligibleSlotsForPosition(s.player.primaryPosition);
    const options: SlotOption[] = [
      ...starterSlots.map((slot) => {
        const cap = capFor(slot, settings.rosterComposition) ?? 0;
        const occupied = (occupiedCount.get(slot) ?? 0) - (currentSlot === slot ? 1 : 0);
        return {
          value: slot,
          label: `${SLOT_LABELS[slot]} (${Math.min(occupied + (currentSlot === slot ? 1 : 0), cap)}/${cap})`,
          disabled: occupied >= cap,
        };
      }),
      { value: "BE", label: "Bench", disabled: false },
    ];

    return { slot: s, currentSlot, game, locked, options };
  });

  const skaterRows = rows.filter((r) => r.slot.player.primaryPosition !== "G");
  const goalieRows = rows.filter((r) => r.slot.player.primaryPosition === "G");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/teams/${teamId}`} className="text-sm text-zinc-500 hover:underline">
        ← {team.name}
      </Link>

      <div className="mt-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Lineup</h1>
        <div className="flex items-center gap-2">
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}/lineup?date=${shiftDate(date, -1)}`}
            className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            ← Prev
          </Link>
          <DateJump leagueId={leagueId} teamId={teamId} date={date} />
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}/lineup?date=${shiftDate(date, 1)}`}
            className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
          >
            Next →
          </Link>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {date === todayUTC() ? "Today" : date} · lineups are freely editable until a player's own game starts
      </p>

      <div className="mt-6">
        <SectionLabel>Skaters</SectionLabel>
        <LineupTable rows={skaterRows} isOwner={isOwner} leagueId={leagueId} teamId={teamId} date={date} />
      </div>

      <div className="mt-6">
        <SectionLabel>Goalies</SectionLabel>
        <LineupTable rows={goalieRows} isOwner={isOwner} leagueId={leagueId} teamId={teamId} date={date} />
      </div>
    </div>
  );
}

interface LineupRow {
  slot: Awaited<ReturnType<typeof getTeamRosterView>>[number];
  currentSlot: string;
  game: { opponent: string; home: boolean } | undefined;
  locked: boolean;
  options: SlotOption[];
}

function LineupTable({
  rows,
  isOwner,
  leagueId,
  teamId,
  date,
}: {
  rows: LineupRow[];
  isOwner: boolean;
  leagueId: string;
  teamId: string;
  date: string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">No players on the active roster.</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
            <th className="py-2 pl-4 pr-2 font-medium">Player</th>
            <th className="py-2 pr-2 font-medium">Opponent</th>
            <th className="py-2 pr-4 pl-2 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ slot: s, currentSlot, game, locked, options }, i) => (
            <tr
              key={s.playerId}
              className={`border-b border-black/5 last:border-0 dark:border-white/5 ${
                i % 2 === 1 ? "bg-black/[.015] dark:bg-white/[.02]" : ""
              }`}
            >
              <td className="py-2 pl-4 pr-2 font-medium">
                {s.player.fullName}
                <span className="ml-2 text-xs text-zinc-500">
                  {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                </span>
              </td>
              <td className="py-2 pr-2 text-zinc-500">
                {game ? `${game.home ? "vs" : "@"} ${game.opponent}${locked ? " · locked" : ""}` : "No game"}
              </td>
              <td className="py-2 pr-4 pl-2 text-right">
                {isOwner ? (
                  <LineupSlotSelect
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={s.playerId}
                    date={date}
                    value={currentSlot}
                    options={options}
                    locked={locked}
                  />
                ) : (
                  <span className="text-xs text-zinc-500">
                    {currentSlot === "BE" ? "Bench" : currentSlot}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
