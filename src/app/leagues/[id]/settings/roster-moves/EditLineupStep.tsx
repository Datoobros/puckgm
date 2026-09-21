import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import { ensureLineupMaterialized, getLineupForDate, eligibleSlotsForPosition } from "@/lib/lineups/mutations";
import { getTeamGamesForDate, isLocked } from "@/lib/lineups/schedule";
import { Card } from "@/components/Card";
import { LineupDatePicker } from "./LineupDatePicker";
import { EditLineupForm, type LineupRow } from "./EditLineupForm";

/** Edit Lineup step 2 (LM Tools Task 12) — a plain table over the team's
 * Active roster, reusing the exact same eligibility helper
 * (eligibleSlotsForPosition) and lock logic (getTeamGamesForDate/isLocked)
 * the team page's own lineup board uses, rather than re-deriving either.
 * Deliberately not the team page's drag-to-move board — this is a rarely
 * used commissioner path and doesn't warrant extracting 1,100 lines of row
 * assembly for. */
export async function EditLineupStep({ leagueId, teamId, performAs, date }: { leagueId: string; teamId: string; performAs: string; date: string }) {
  await ensureLineupMaterialized(teamId, date);

  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, include: { league: true } });
  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const positionMode = settings.rosterComposition.positionMode;

  const [rosterSlots, lineupEntries, teamGames] = await Promise.all([
    getTeamRosterView(teamId),
    getLineupForDate(teamId, date),
    getTeamGamesForDate(date),
  ]);
  const activeSlots = rosterSlots.filter((s) => s.slotType === "ACTIVE");
  const slotByPlayer = new Map(lineupEntries.map((e) => [e.playerId, e.lineupSlot]));

  const rows: LineupRow[] = activeSlots.map((s) => {
    const game = s.player.currentNhlOrg ? teamGames.get(s.player.currentNhlOrg) : undefined;
    const locked = game ? isLocked(game) : false;
    const opponentLabel = game ? `${game.home ? "vs" : "@"} ${game.opponent}${locked ? " · locked" : ""}` : "No game";
    const currentSlot = slotByPlayer.get(s.playerId) ?? "BE";
    return {
      playerId: s.playerId,
      fullName: s.player.fullName,
      headshotUrl: s.player.headshotUrl,
      position: s.player.primaryPosition ?? "—",
      opponentLabel,
      locked,
      currentSlot,
      eligibleSlots: ["BE", ...eligibleSlotsForPosition(s.player.primaryPosition, positionMode)],
    };
  });

  return (
    <div className="max-w-3xl">
      <p className="mb-3 text-xs text-muted">
        ⓘ Perform-as is ignored for lineups — this always applies exactly as {team.name}&apos;s own manager would.
        Game-time locks always apply: a player whose game has already started can&apos;t be moved.
      </p>
      <div className="mb-4">
        <LineupDatePicker leagueId={leagueId} teamId={teamId} performAs={performAs} date={date} />
      </div>
      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No players on the active roster.</p>
        </Card>
      ) : (
        <EditLineupForm leagueId={leagueId} teamId={teamId} date={date} rows={rows} />
      )}
    </div>
  );
}
