import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getTeamSchedule } from "@/lib/matchups/standings";
import { Card } from "@/components/Card";

export default async function TeamSchedulePage(props: PageProps<"/leagues/[id]/teams/[teamId]/schedule">) {
  await auth.protect();
  const { id: leagueId, teamId } = await props.params;

  const team = await prisma.team.findUnique({ where: { id: teamId }, include: { league: true } });
  if (!team || team.leagueId !== leagueId) notFound();

  const settings = team.league.settingsJson as unknown as LeagueSettings;
  const rows = await getTeamSchedule(teamId, leagueId, team.league.currentSeason, settings.scoringConfig);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/teams/${teamId}`} className="text-sm text-muted hover:underline">
        ← {team.name}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{team.name}&apos;s Schedule</h1>
      <p className="mt-1 text-sm text-muted">
        {team.league.currentSeason}-{(team.league.currentSeason + 1) % 100} season
      </p>

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
                      <Link href={`/leagues/${leagueId}/teams/${r.opponentTeamId}`} className="font-medium hover:underline">
                        {r.opponentTeamName}
                      </Link>
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
