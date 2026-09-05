import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getStandings, getScoreboardForPeriod, type StandingsRow } from "@/lib/matchups/standings";
import { Card, SectionLabel } from "@/components/Card";

function StandingsTable({ rows }: { rows: StandingsRow[] }) {
  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pl-4 pr-2 font-medium">Team</th>
            <th className="py-2 pr-2 text-right font-medium">W</th>
            <th className="py-2 pr-2 text-right font-medium">L</th>
            <th className="py-2 pr-2 text-right font-medium">T</th>
            <th className="py-2 pr-2 text-right font-medium">PF</th>
            <th className="py-2 pr-4 text-right font-medium">PA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.teamId} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface-tint" : ""}`}>
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
  );
}

export default async function StandingsPage(props: PageProps<"/leagues/[id]/standings">) {
  await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId, season: league.currentSeason } })) > 0;
  const standings = hasSchedule ? await getStandings(leagueId, league.currentSeason, settings.scoringConfig) : [];
  // Divisions are display/standings-grouping only (src/lib/matchups/
  // standings.ts) — deliberately not wired into schedule generation or
  // playoff seeding, so this is the only place grouping happens.
  const hasDivisions = standings.some((r) => r.division !== null);
  const divisionGroups: [string, StandingsRow[]][] = hasDivisions
    ? Array.from(
        standings
          .reduce((map, r) => {
            const key = r.division ?? "No division";
            (map.get(key) ?? map.set(key, []).get(key)!).push(r);
            return map;
          }, new Map<string, StandingsRow[]>())
          .entries(),
      )
    : [];

  const playoffPeriods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season: league.currentSeason, isPlayoffs: true },
    orderBy: { periodNo: "asc" },
  });
  const playoffRounds = await Promise.all(
    playoffPeriods.map((p) => getScoreboardForPeriod(leagueId, league.currentSeason, settings.scoringConfig, p.periodNo)),
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Standings</h1>
      <p className="mt-1 text-sm text-muted">
        {league.currentSeason}-{(league.currentSeason + 1) % 100} regular season
      </p>

      <div className="mt-6 space-y-6">
        {!hasSchedule ? (
          <Card>
            <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
          </Card>
        ) : hasDivisions ? (
          divisionGroups.map(([division, rows]) => (
            <div key={division}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{division}</p>
              <StandingsTable rows={rows} />
            </div>
          ))
        ) : (
          <StandingsTable rows={standings} />
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        Only completed weeks count toward the record — a week in progress isn&apos;t final yet.
        Playoff results don&apos;t affect this table.
      </p>

      {playoffRounds.length > 0 && (
        <div className="mt-8">
          <SectionLabel>Playoffs</SectionLabel>
          <div className="space-y-4">
            {playoffRounds.map((round) =>
              round ? (
                <div key={round.periodId}>
                  <p className="mb-2 text-sm font-medium text-gold">
                    {round.roundLabel}
                    {round.matchups.length > 0 && !round.matchups.some((m) => m.final) && (
                      <span className="ml-2 text-xs font-normal text-muted">in progress</span>
                    )}
                  </p>
                  {round.matchups.length === 0 ? (
                    <Card>
                      <p className="text-sm text-muted">
                        Waiting on the previous round to finish.
                      </p>
                    </Card>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {round.matchups.map((m) => (
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
                      ))}
                    </div>
                  )}
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}
