import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, isLeagueCommissioner } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getScoreboardForPeriod, getTeamSchedule, playoffRoundLabel } from "@/lib/matchups/standings";
import { Card } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { TeamScheduleList } from "@/components/TeamScheduleList";
import { LinkButton, Badge } from "@/components/Button";
import { teamInitials } from "@/lib/teams/initials";
import { TeamScheduleSelect } from "./TeamScheduleSelect";
import { MatchupWeekSelect, type WeekOption } from "./MatchupWeekSelect";
import { AdjustScoringModal } from "./AdjustScoringModal";
import type { TopScorer, ScoreAdjustmentSummary } from "@/lib/matchups/standings";

export default async function ScoreboardPage(props: PageProps<"/leagues/[id]/scoreboard">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawWeek = Array.isArray(sp.week) ? sp.week[0] : sp.week;
  const requestedPeriodNo = rawWeek ? Number(rawWeek) : undefined;
  const rawTeam = Array.isArray(sp.team) ? sp.team[0] : sp.team;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const isCommissioner = await isLeagueCommissioner(leagueId, userId);

  const teams = await prisma.team.findMany({ where: { leagueId }, orderBy: { name: "asc" } });
  const selectedTeam = rawTeam ? teams.find((t) => t.id === rawTeam) : undefined;

  if (selectedTeam) {
    const rows = await getTeamSchedule(selectedTeam.id, leagueId, league.currentSeason, settings.scoringConfig);
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>
          <TeamScheduleSelect leagueId={leagueId} teams={teams} selectedTeamId={selectedTeam.id} />
        </div>
        <p className="mt-1 text-sm text-muted">{selectedTeam.name}&apos;s full-season schedule</p>

        <div className="mt-6">
          <TeamScheduleList leagueId={leagueId} rows={rows} />
        </div>
      </div>
    );
  }

  const [scoreboard, periods] = await Promise.all([
    getScoreboardForPeriod(leagueId, league.currentSeason, settings.scoringConfig, requestedPeriodNo),
    prisma.matchupPeriod.findMany({ where: { leagueId, season: league.currentSeason }, orderBy: { periodNo: "asc" } }),
  ]);

  const playoffPeriods = periods.filter((p) => p.isPlayoffs);
  const weekOptions: WeekOption[] = periods.map((p) => ({
    periodNo: p.periodNo,
    isPlayoffs: p.isPlayoffs,
    roundLabel: p.isPlayoffs ? playoffRoundLabel(playoffPeriods.length, playoffPeriods.findIndex((pp) => pp.id === p.id)) : null,
    startDate: p.startDate,
    endDate: p.endDate,
  }));

  const isFinal = scoreboard ? scoreboard.matchups.some((m) => m.final) : false;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>
          <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
        </div>
        <div className="flex items-center gap-4">
          <LinkButton variant="ghost" href={`/leagues/${leagueId}/schedule`}>
            Full schedule
          </LinkButton>
          <LinkButton variant="ghost" href={`/leagues/${leagueId}/standings/bracket`}>
            Projected Playoff Bracket
          </LinkButton>
        </div>
      </div>

      {!scoreboard ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
        </Card>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">Matchups</span>
            <MatchupWeekSelect leagueId={leagueId} options={weekOptions} selectedPeriodNo={scoreboard.periodNo} />
            <Badge tone={isFinal ? "muted" : "success"}>{isFinal ? "Final" : "In progress"}</Badge>
            <div className="ml-auto">
              <TeamScheduleSelect leagueId={leagueId} teams={teams} selectedTeamId="" />
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-4">
            {scoreboard.matchups.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">Bye week for every team, or nothing scheduled.</p>
              </Card>
            ) : (
              scoreboard.matchups.map((m) => (
                <MatchupCard
                  key={m.matchupId}
                  leagueId={leagueId}
                  matchupId={m.matchupId}
                  matchupPeriodId={scoreboard.periodId}
                  final={m.final}
                  isCommissioner={isCommissioner}
                  home={{
                    teamId: m.homeTeamId,
                    name: m.homeTeamName,
                    logoUrl: m.homeTeamLogoUrl,
                    seed: m.homeSeed,
                    score: m.homeScore,
                    topScorers: m.homeTopScorers,
                    adjustments: m.homeAdjustments,
                  }}
                  away={{
                    teamId: m.awayTeamId,
                    name: m.awayTeamName,
                    logoUrl: m.awayTeamLogoUrl,
                    seed: m.awaySeed,
                    score: m.awayScore,
                    topScorers: m.awayTopScorers,
                    adjustments: m.awayAdjustments,
                  }}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface MatchupSide {
  teamId: string;
  name: string;
  logoUrl: string | null;
  seed: number | null;
  score: number;
  topScorers: TopScorer[];
  adjustments: ScoreAdjustmentSummary[];
}

/** "Connor McDavid" -> "C. McDavid" — the top-scorer row's compact name
 * format (there isn't room for a full name beside a 40px headshot in a
 * three-player-wide row). */
function shortPlayerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** ESPN-style full-width matchup card: teams column, top-scorers column,
 * and a "Matchup" action column, separated by dividers (stacks to one
 * column on mobile). Replaces the old small centered-score card. */
function MatchupCard({
  leagueId,
  matchupId,
  matchupPeriodId,
  final,
  isCommissioner,
  home,
  away,
}: {
  leagueId: string;
  matchupId: string;
  matchupPeriodId: string;
  final: boolean;
  isCommissioner: boolean;
  home: MatchupSide;
  away: MatchupSide;
}) {
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <div className="divide-y divide-border border-b border-border md:border-b-0 md:border-r">
          <TeamRow side={home} final={final} otherScore={away.score} />
          <TeamRow side={away} final={final} otherScore={home.score} />
        </div>
        <div className="divide-y divide-border border-b border-border md:border-b-0 md:border-r">
          <TopScorersRow side={home} />
          <TopScorersRow side={away} />
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 p-4">
          <LinkButton variant="secondary" className="rounded-full px-5" href={`/leagues/${leagueId}/matchups/${matchupId}`}>
            Matchup
          </LinkButton>
          {isCommissioner && (
            <AdjustScoringModal leagueId={leagueId} matchupPeriodId={matchupPeriodId} home={home} away={away} />
          )}
        </div>
      </div>
    </Card>
  );
}

function TeamRow({ side, final, otherScore }: { side: MatchupSide; final: boolean; otherScore: number }) {
  const trailing = final && side.score < otherScore;
  return (
    <div className="flex items-center gap-3 p-4">
      <TeamLogo url={side.logoUrl} alt={side.name} size={44} />
      <div className={`min-w-0 flex-1 truncate text-lg font-semibold ${trailing ? "text-muted" : ""}`}>
        {side.seed !== null && <span className="text-muted">({side.seed}) </span>}
        {side.name}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-2xl font-bold tabular-nums">{side.score.toFixed(1)}</div>
        {side.adjustments.length > 0 && <div className="text-[10px] text-muted">(adj.)</div>}
      </div>
    </div>
  );
}

function TopScorersRow({ side }: { side: MatchupSide }) {
  return (
    <div className="flex items-start gap-4 p-4">
      <div className="w-24 shrink-0">
        <div className="text-sm text-muted">Top Scorers</div>
        <div className="text-xs font-semibold">{teamInitials(side.name)}</div>
      </div>
      {side.topScorers.length === 0 ? (
        <div className="pt-1 text-sm text-muted">Lineup not set</div>
      ) : (
        <div className="flex flex-1 flex-wrap gap-4">
          {side.topScorers.map((p) => (
            <div key={p.playerId} className="flex items-center gap-2" title={p.fullName}>
              <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={40} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{shortPlayerName(p.fullName)}</div>
                <div className="text-xs text-muted">{p.points.toFixed(1)} pts</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
