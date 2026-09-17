import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { generateScheduleAction } from "@/app/leagues/actions";
import { ResetScheduleButton } from "@/components/ResetScheduleButton";
import { Button, Badge } from "@/components/Button";
import { Card, SectionLabel } from "@/components/Card";
import { prisma } from "@/lib/db";
import { DEFAULT_SEASON_START } from "@/lib/matchups/constants";

export default async function ScheduleSettingsPage(props: PageProps<"/leagues/[id]/settings/schedule-settings">) {
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const currentSeason = league.currentSeason;
  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId, season: currentSeason } })) > 0;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Edit Schedule Settings</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Generate or reset the regular-season (and optional playoff) schedule for the current
        season.
      </p>
      {/* TODO(Task 11): link to /leagues/[id]/schedule once the League Schedule page ships. */}

      <div className="mt-8">
        <SectionLabel>Schedule</SectionLabel>
        <Card>
          {hasSchedule ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {currentSeason}-{(currentSeason + 1) % 100} schedule generated —
                see Scoreboard / Standings.
              </p>
              <ResetScheduleButton leagueId={leagueId} season={currentSeason} />
            </div>
          ) : (
            <form action={generateScheduleAction.bind(null, leagueId)} className="space-y-2">
              <p className="text-xs text-muted">
                Generate a round-robin schedule for the {currentSeason}-
                {(currentSeason + 1) % 100} season. Can be reset and regenerated until a
                week actually completes.
              </p>
              <input type="hidden" name="season" value={currentSeason} />
              <label className="block text-xs text-muted">
                Start date
                <input
                  type="date"
                  name="startDate"
                  defaultValue={DEFAULT_SEASON_START}
                  required
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
                />
              </label>
              <label className="block text-xs text-muted">
                Regular season weeks
                <input
                  type="number"
                  name="weekCount"
                  defaultValue={21}
                  min={1}
                  required
                  className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs text-muted">
                Playoff bracket (right after the regular season — round count follows from bracket size)
                <select
                  name="playoffTeams"
                  defaultValue={0}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
                >
                  <option value={0}>None</option>
                  <option value={2}>2 teams (1 round — Championship)</option>
                  <option value={4}>4 teams (2 rounds — Semifinal, Championship)</option>
                  <option value={8}>8 teams (3 rounds — Quarterfinal, Semifinal, Championship)</option>
                </select>
              </label>
              <Button type="submit" variant="primary" size="sm" className="mt-1">
                Generate Schedule
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
