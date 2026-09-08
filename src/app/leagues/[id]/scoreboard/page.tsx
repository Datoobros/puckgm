import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getScoreboardForPeriod, getTeamSchedule } from "@/lib/matchups/standings";
import { Card } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { TeamScheduleList } from "@/components/TeamScheduleList";
import { TeamScheduleSelect } from "./TeamScheduleSelect";
import type { TopScorer } from "@/lib/matchups/standings";

export default async function ScoreboardPage(props: PageProps<"/leagues/[id]/scoreboard">) {
  await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawWeek = Array.isArray(sp.week) ? sp.week[0] : sp.week;
  const requestedPeriodNo = rawWeek ? Number(rawWeek) : undefined;
  const rawTeam = Array.isArray(sp.team) ? sp.team[0] : sp.team;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

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

  const [scoreboard, periodCount] = await Promise.all([
    getScoreboardForPeriod(leagueId, league.currentSeason, settings.scoringConfig, requestedPeriodNo),
    prisma.matchupPeriod.count({ where: { leagueId, season: league.currentSeason } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>
        {scoreboard && <TeamScheduleSelect leagueId={leagueId} teams={teams} selectedTeamId="" />}
      </div>

      {!scoreboard ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
        </Card>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <Link
              href={`/leagues/${leagueId}/scoreboard?week=${Math.max(1, scoreboard.periodNo - 1)}`}
              className={`rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint ${
                scoreboard.periodNo <= 1 ? "pointer-events-none opacity-30" : ""
              }`}
            >
              ← Prev
            </Link>
            <span className="text-sm text-muted">
              {scoreboard.isPlayoffs && <span className="font-medium text-gold">{scoreboard.roundLabel} · </span>}
              Week {scoreboard.periodNo} of {periodCount}
              {" · "}
              {scoreboard.startDate.toISOString().slice(0, 10)} – {scoreboard.endDate.toISOString().slice(0, 10)}
              {" · "}
              {scoreboard.matchups.some((m) => m.final) ? "Final" : "In progress"}
            </span>
            <Link
              href={`/leagues/${leagueId}/scoreboard?week=${Math.min(periodCount, scoreboard.periodNo + 1)}`}
              className={`rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint ${
                scoreboard.periodNo >= periodCount ? "pointer-events-none opacity-30" : ""
              }`}
            >
              Next →
            </Link>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {scoreboard.matchups.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">Bye week for every team, or nothing scheduled.</p>
              </Card>
            ) : (
              scoreboard.matchups.map((m) => (
                <Card key={m.matchupId} className="!p-0 overflow-hidden">
                  <div className="divide-y divide-border">
                    <MatchupSideRow
                      name={m.homeTeamName}
                      logoUrl={m.homeTeamLogoUrl}
                      seed={m.homeSeed}
                      score={m.homeScore}
                      winning={m.homeScore >= m.awayScore}
                      topScorers={m.homeTopScorers}
                    />
                    <MatchupSideRow
                      name={m.awayTeamName}
                      logoUrl={m.awayTeamLogoUrl}
                      seed={m.awaySeed}
                      score={m.awayScore}
                      winning={m.awayScore >= m.homeScore}
                      topScorers={m.awayTopScorers}
                    />
                  </div>
                </Card>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One team's half of a matchup card — logo, name/seed, score, and up to 3
 * real top scorers for the period so far. Not "Projected Leaders" like
 * ESPN's — this app has no stat-projection data source, so this is actual
 * fantasy points scored within the period, honestly labeled as such. */
function MatchupSideRow({
  name,
  logoUrl,
  seed,
  score,
  winning,
  topScorers,
}: {
  name: string;
  logoUrl: string | null;
  seed: number | null;
  score: number;
  winning: boolean;
  topScorers: TopScorer[];
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <TeamLogo url={logoUrl} alt={name} size={40} />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm ${winning ? "font-semibold" : ""}`}>
          {seed !== null && <span className="text-muted">({seed}) </span>}
          {name}
        </div>
        {topScorers.length > 0 && (
          <div className="mt-1 flex items-center gap-3 overflow-x-auto">
            {topScorers.map((p) => (
              <div key={p.playerId} className="flex shrink-0 items-center gap-1" title={p.fullName}>
                <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={18} />
                <span className="text-[11px] text-muted">
                  {p.fullName.split(" ").slice(-1)[0]} {p.points.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <span className={`shrink-0 tabular-nums text-lg ${winning ? "font-semibold" : "text-muted"}`}>
        {score.toFixed(1)}
      </span>
    </div>
  );
}
