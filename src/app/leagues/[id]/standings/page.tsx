import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getStandings } from "@/lib/matchups/standings";
import { CURRENT_SCHEDULE_SEASON } from "@/lib/matchups/constants";
import { Card } from "@/components/Card";

export default async function StandingsPage(props: PageProps<"/leagues/[id]/standings">) {
  await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId, season: CURRENT_SCHEDULE_SEASON } })) > 0;
  const standings = hasSchedule ? await getStandings(leagueId, CURRENT_SCHEDULE_SEASON, settings.scoringConfig) : [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Standings</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {CURRENT_SCHEDULE_SEASON}-{(CURRENT_SCHEDULE_SEASON + 1) % 100} regular season
      </p>

      <div className="mt-6">
        {!hasSchedule ? (
          <Card>
            <p className="text-sm text-zinc-500">No schedule yet — the commissioner can generate one from the League page.</p>
          </Card>
        ) : (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
                  <th className="py-2 pl-4 pr-2 font-medium">Team</th>
                  <th className="py-2 pr-2 text-right font-medium">W</th>
                  <th className="py-2 pr-2 text-right font-medium">L</th>
                  <th className="py-2 pr-2 text-right font-medium">T</th>
                  <th className="py-2 pr-2 text-right font-medium">PF</th>
                  <th className="py-2 pr-4 text-right font-medium">PA</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row, i) => (
                  <tr
                    key={row.teamId}
                    className={`border-b border-black/5 last:border-0 dark:border-white/5 ${
                      i % 2 === 1 ? "bg-black/[.015] dark:bg-white/[.02]" : ""
                    }`}
                  >
                    <td className="py-2 pl-4 pr-2 font-medium">{row.teamName}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.wins}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.losses}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.ties}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.pointsFor.toFixed(1)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.pointsAgainst.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Only completed weeks count toward the record — a week in progress isn&apos;t final yet.
      </p>
    </div>
  );
}
