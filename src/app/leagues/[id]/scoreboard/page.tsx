import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getScoreboardForPeriod, getTeamSchedule } from "@/lib/matchups/standings";
import { Card } from "@/components/Card";
import { TeamScheduleSelect } from "./TeamScheduleSelect";

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

        {rows.length === 0 ? (
          <Card className="mt-6">
            <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
          </Card>
        ) : (
          <Card className="mt-6 !p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.periodNo} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span>
                    <span className="text-xs text-muted">
                      {r.isPlayoffs ? r.roundLabel : `Week ${r.periodNo}`}
                      {" · "}
                      {r.startDate.toISOString().slice(0, 10)}
                    </span>
                    <br />
                    {r.bye ? (
                      <span className="text-muted">Bye</span>
                    ) : (
                      <>
                        <span className="text-xs text-muted">{r.isHome ? "vs" : "@"} </span>
                        <span className="font-medium">{r.opponentTeamName}</span>
                      </>
                    )}
                  </span>
                  {!r.bye && r.final && (
                    <span
                      className={`tabular-nums text-sm ${r.myScore >= r.opponentScore ? "font-semibold text-foreground" : "text-muted"}`}
                    >
                      {r.myScore.toFixed(1)} – {r.opponentScore.toFixed(1)}
                    </span>
                  )}
                  {!r.bye && !r.final && <span className="text-xs text-muted">Upcoming</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
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

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {scoreboard.matchups.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">Bye week for every team, or nothing scheduled.</p>
              </Card>
            ) : (
              scoreboard.matchups.map((m) => (
                <Card key={m.matchupId}>
                  <div className="flex items-center justify-between text-sm">
                    <span className={m.homeScore >= m.awayScore ? "font-semibold" : ""}>
                      {m.homeSeed !== null && <span className="text-muted">({m.homeSeed}) </span>}
                      {m.homeTeamName}
                    </span>
                    <span className="tabular-nums">{m.homeScore.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className={m.awayScore >= m.homeScore ? "font-semibold" : ""}>
                      {m.awaySeed !== null && <span className="text-muted">({m.awaySeed}) </span>}
                      {m.awayTeamName}
                    </span>
                    <span className="tabular-nums">{m.awayScore.toFixed(1)}</span>
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
