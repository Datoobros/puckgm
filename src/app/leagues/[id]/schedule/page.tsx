import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager, isLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { getLeagueSchedule, getAvailableSeasons, type LeagueSchedulePeriod, type LeagueScheduleTeamSide } from "@/lib/matchups/standings";
import { formatPeriodRange } from "@/lib/dates";
import { Card } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";
import { LinkButton, Badge } from "@/components/Button";
import { ScheduleFilters } from "./ScheduleFilters";
import { PeriodEditor } from "./PeriodEditor";

export default async function SchedulePage(props: PageProps<"/leagues/[id]/schedule">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawSeason = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const rawTeam = Array.isArray(sp.team) ? sp.team[0] : sp.team;
  const rawEdit = Array.isArray(sp.edit) ? sp.edit[0] : sp.edit;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  // Same membership gate as /leagues/[id]/draft/recap — a public league page
  // with real content to protect, unlike the Draft/Scoreboard pages, which
  // stay open to any signed-in user.
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;
  if (!myTeam) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">League Schedule</h1>
        <Card className="mt-6">
          <p className="text-sm text-muted">
            You&apos;re not a member of this league. Ask the commissioner for an invite link to join.
          </p>
        </Card>
      </div>
    );
  }

  const settings = league.settingsJson as unknown as LeagueSettings;
  const isCommissioner = await isLeagueCommissioner(leagueId, userId);

  const availableSeasons = await getAvailableSeasons(leagueId, league.currentSeason);
  const season = rawSeason && availableSeasons.includes(Number(rawSeason)) ? Number(rawSeason) : league.currentSeason;

  const schedule = await getLeagueSchedule(leagueId, season, settings.scoringConfig);
  const teams = [...league.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ id: t.id, name: t.name }));
  const selectedTeamId = rawTeam && teams.some((t) => t.id === rawTeam) ? rawTeam : "";

  const visiblePeriods = selectedTeamId
    ? schedule
        .map((p) => ({
          ...p,
          matchups: p.matchups.filter((m) => m.home.teamId === selectedTeamId || m.away.teamId === selectedTeamId),
        }))
        .filter((p) => p.matchups.length > 0)
    : schedule;

  const editingPeriodId = isCommissioner && rawEdit && schedule.some((p) => p.periodId === rawEdit && p.editable) ? rawEdit : null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">League Schedule</h1>
          <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
        </div>
        <LinkButton variant="ghost" href={`/leagues/${leagueId}/standings/bracket`}>
          Projected Playoff Bracket
        </LinkButton>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ScheduleFilters
          leagueId={leagueId}
          season={season}
          availableSeasons={availableSeasons}
          teams={teams}
          selectedTeamId={selectedTeamId}
        />
      </div>

      {schedule.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">
            No schedule yet — the commissioner can generate one from LM Tools → Edit Schedule Settings.
          </p>
        </Card>
      ) : visiblePeriods.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">No matchups found for that filter.</p>
        </Card>
      ) : (
        <div className="mt-6 space-y-8">
          {visiblePeriods.map((period) => (
            <PeriodSection
              key={period.periodId}
              leagueId={leagueId}
              season={season}
              period={period}
              teams={teams}
              isCommissioner={isCommissioner}
              isEditing={editingPeriodId === period.periodId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PeriodSection({
  leagueId,
  season,
  period,
  teams,
  isCommissioner,
  isEditing,
}: {
  leagueId: string;
  season: number;
  period: LeagueSchedulePeriod;
  teams: { id: string; name: string }[];
  isCommissioner: boolean;
  isEditing: boolean;
}) {
  const heading = period.isPlayoffs ? period.roundLabel : `Matchup ${period.periodNo}`;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {heading} <span className="font-normal text-muted">({formatPeriodRange(period.startDate, period.endDate)})</span>
        </h2>
        {isCommissioner && period.editable && !isEditing && (
          <Link
            href={`/leagues/${leagueId}/schedule?${new URLSearchParams({ season: String(season), edit: period.periodId }).toString()}`}
            className="rounded-full border border-border px-3 py-0.5 text-xs font-medium text-blue hover:bg-surface-tint"
          >
            Edit
          </Link>
        )}
      </div>

      {isEditing ? (
        <div className="mt-2">
          <PeriodEditor
            leagueId={leagueId}
            season={season}
            periodId={period.periodId}
            teams={teams}
            initialPairs={period.matchups.map((m) => ({ homeTeamId: m.home.teamId, awayTeamId: m.away.teamId }))}
          />
        </div>
      ) : (
        <Card className="mt-2 overflow-x-auto !p-0">
          {period.matchups.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              {period.isPlayoffs ? "Waiting on the previous round to finish." : "Bye week for every team."}
            </p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Away Team</th>
                  <th className="px-4 py-2 font-medium">Team Manager(s)</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 font-medium">Team Manager(s)</th>
                  <th className="px-4 py-2 font-medium">Home Team</th>
                </tr>
              </thead>
              <tbody>
                {period.matchups.map((m) => (
                  <tr key={m.matchupId} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <TeamCell leagueId={leagueId} team={m.away} showRecord={!period.isPlayoffs} />
                    </td>
                    <td className="px-4 py-3 text-muted">{m.away.managerNames}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{m.final ? m.away.score.toFixed(1) : "-"}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{m.final ? m.home.score.toFixed(1) : "-"}</td>
                    <td className="px-4 py-3 text-muted">{m.home.managerNames}</td>
                    <td className="px-4 py-3">
                      <TeamCell leagueId={leagueId} team={m.home} showRecord={!period.isPlayoffs} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

function TeamCell({ leagueId, team, showRecord }: { leagueId: string; team: LeagueScheduleTeamSide; showRecord: boolean }) {
  return (
    <Link href={`/leagues/${leagueId}/teams/${team.teamId}`} className="flex items-center gap-2 font-medium hover:underline">
      <TeamLogo url={team.logoUrl} alt={team.teamName} size={28} />
      <span>
        {team.seed !== null && <span className="text-muted">({team.seed}) </span>}
        {team.teamName}
        {showRecord && <span className="ml-1 text-xs font-normal text-muted">({team.record})</span>}
      </span>
    </Link>
  );
}
