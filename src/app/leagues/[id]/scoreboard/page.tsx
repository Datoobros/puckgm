import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getScoreboardForPeriod } from "@/lib/matchups/standings";
import { CURRENT_SCHEDULE_SEASON } from "@/lib/matchups/constants";
import { Card } from "@/components/Card";

export default async function ScoreboardPage(props: PageProps<"/leagues/[id]/scoreboard">) {
  await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawWeek = Array.isArray(sp.week) ? sp.week[0] : sp.week;
  const requestedPeriodNo = rawWeek ? Number(rawWeek) : undefined;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const [scoreboard, periodCount] = await Promise.all([
    getScoreboardForPeriod(leagueId, CURRENT_SCHEDULE_SEASON, settings.scoringConfig, requestedPeriodNo),
    prisma.matchupPeriod.count({ where: { leagueId, season: CURRENT_SCHEDULE_SEASON } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>

      {!scoreboard ? (
        <Card className="mt-6">
          <p className="text-sm text-zinc-500">No schedule yet — the commissioner can generate one from the League page.</p>
        </Card>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <Link
              href={`/leagues/${leagueId}/scoreboard?week=${Math.max(1, scoreboard.periodNo - 1)}`}
              className={`rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05] ${
                scoreboard.periodNo <= 1 ? "pointer-events-none opacity-30" : ""
              }`}
            >
              ← Prev
            </Link>
            <span className="text-sm text-zinc-500">
              Week {scoreboard.periodNo} of {periodCount}
              {" · "}
              {scoreboard.startDate.toISOString().slice(0, 10)} – {scoreboard.endDate.toISOString().slice(0, 10)}
              {" · "}
              {scoreboard.matchups.some((m) => m.final) ? "Final" : "In progress"}
            </span>
            <Link
              href={`/leagues/${leagueId}/scoreboard?week=${Math.min(periodCount, scoreboard.periodNo + 1)}`}
              className={`rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05] ${
                scoreboard.periodNo >= periodCount ? "pointer-events-none opacity-30" : ""
              }`}
            >
              Next →
            </Link>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {scoreboard.matchups.length === 0 ? (
              <Card>
                <p className="text-sm text-zinc-500">Bye week for every team, or nothing scheduled.</p>
              </Card>
            ) : (
              scoreboard.matchups.map((m) => (
                <Card key={m.matchupId}>
                  <div className="flex items-center justify-between text-sm">
                    <span className={m.homeScore >= m.awayScore ? "font-semibold" : ""}>{m.homeTeamName}</span>
                    <span className="tabular-nums">{m.homeScore.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className={m.awayScore >= m.homeScore ? "font-semibold" : ""}>{m.awayTeamName}</span>
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
