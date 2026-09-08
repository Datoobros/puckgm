import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import {
  getStandings,
  getScoreboardForPeriod,
  getTeamSeasonStats,
  getTeamMoveCounts,
  getAvailableSeasons,
  estimatePlayoffOdds,
  type StandingsRow,
} from "@/lib/matchups/standings";
import { Card, SectionLabel } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";
import { SeasonSelect } from "./SeasonSelect";
import { SeasonStatsTable, type SeasonStatsRow } from "./SeasonStatsTable";

function formatPct(wins: number, losses: number, ties: number): string {
  const games = wins + losses + ties;
  if (games === 0) return ".000";
  const pct = (wins + ties * 0.5) / games;
  return pct.toFixed(3).replace(/^0/, "");
}

function StandingsTable({
  rows,
  leagueId,
  myTeamId,
  bracketSize,
  totalTeams,
}: {
  rows: StandingsRow[];
  leagueId: string;
  myTeamId: string | null;
  bracketSize: number;
  totalTeams: number;
}) {
  const anyGamesPlayed = rows.some((r) => r.wins + r.losses + r.ties > 0);
  const leaderGames = rows[0] ? rows[0].wins + rows[0].losses + rows[0].ties : 0;

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pl-4 pr-2 font-medium">Rk</th>
            <th className="py-2 pr-2 font-medium">Team</th>
            <th className="py-2 pr-2 text-right font-medium">W</th>
            <th className="py-2 pr-2 text-right font-medium">L</th>
            <th className="py-2 pr-2 text-right font-medium">T</th>
            <th className="py-2 pr-2 text-right font-medium">PCT</th>
            <th className="py-2 pr-2 text-right font-medium">GB</th>
            {bracketSize > 0 && <th className="py-2 pr-4 text-right font-medium">Playoff %</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const games = row.wins + row.losses + row.ties;
            const gb =
              i === 0 || leaderGames === 0
                ? "--"
                : (((rows[0].wins - row.wins) + (row.losses - rows[0].losses)) / 2).toFixed(1);
            const odds = anyGamesPlayed ? estimatePlayoffOdds(i + 1, totalTeams, bracketSize) : null;
            const isMe = row.teamId === myTeamId;
            return (
              <tr key={row.teamId} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface-tint" : ""}`}>
                <td className="py-2 pl-4 pr-2 text-muted tabular-nums">{anyGamesPlayed ? i + 1 : "--"}</td>
                <td className="py-2 pr-2">
                  <Link
                    href={`/leagues/${leagueId}/teams/${row.teamId}`}
                    className={`flex items-center gap-2 hover:underline ${isMe ? "font-semibold text-blue" : "font-medium"}`}
                  >
                    <TeamLogo url={row.logoUrl} alt={row.teamName} size={22} />
                    {row.teamName}
                  </Link>
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{row.wins}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{row.losses}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{row.ties}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatPct(row.wins, row.losses, row.ties)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{games === 0 ? "--" : gb}</td>
                {bracketSize > 0 && (
                  <td className="py-2 pr-4 text-right tabular-nums">{odds === null ? "--" : `${odds}%`}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

export default async function StandingsPage(props: PageProps<"/leagues/[id]/standings">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawSeason = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const rawDiv = Array.isArray(sp.div) ? sp.div[0] : sp.div;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;

  const availableSeasons = await getAvailableSeasons(leagueId, league.currentSeason);
  const season = rawSeason && availableSeasons.includes(Number(rawSeason)) ? Number(rawSeason) : league.currentSeason;
  const div = rawDiv ?? "Full";

  const hasSchedule = (await prisma.matchupPeriod.count({ where: { leagueId, season } })) > 0;
  const [standings, seasonStats, moveCounts] = await Promise.all([
    hasSchedule ? getStandings(leagueId, season, settings.scoringConfig) : Promise.resolve([]),
    getTeamSeasonStats(leagueId, season),
    getTeamMoveCounts(leagueId, season),
  ]);

  const hasDivisions = standings.some((r) => r.division !== null);
  const divisionNames = hasDivisions ? Array.from(new Set(standings.map((r) => r.division ?? "No division"))) : [];
  const visibleStandings = div === "Full" ? standings : standings.filter((r) => (r.division ?? "No division") === div);

  const playoffPeriods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season, isPlayoffs: true },
    orderBy: { periodNo: "asc" },
  });
  const bracketSize = playoffPeriods.length > 0 ? 2 ** playoffPeriods.length : 0;
  const playoffRounds = await Promise.all(
    playoffPeriods.map((p) => getScoreboardForPeriod(leagueId, season, settings.scoringConfig, p.periodNo)),
  );

  const seasonStatsRows: SeasonStatsRow[] = league.teams
    .filter((t) => div === "Full" || (t.division ?? "No division") === div)
    .map((t) => {
      const standingsRow = standings.find((r) => r.teamId === t.id);
      const stats = seasonStats.get(t.id);
      return {
        teamId: t.id,
        teamName: t.name,
        logoUrl: t.logoUrl,
        isMyTeam: myTeam?.id === t.id,
        goals: stats?.goals ?? 0,
        assists: stats?.assists ?? 0,
        sog: stats?.sog ?? 0,
        hits: stats?.hits ?? 0,
        blockedShots: stats?.blockedShots ?? 0,
        wins: stats?.wins ?? 0,
        goalsAgainst: stats?.goalsAgainst ?? 0,
        saves: stats?.saves ?? 0,
        shutouts: stats?.shutouts ?? 0,
        otl: stats?.otl ?? 0,
        pointsFor: standingsRow?.pointsFor ?? 0,
        pointsAgainst: standingsRow?.pointsAgainst ?? 0,
        streak: standingsRow?.streak ?? "-",
        moves: moveCounts.get(t.id) ?? 0,
      };
    });

  function tabHref(d: string): string {
    const params = new URLSearchParams();
    params.set("season", String(season));
    if (d !== "Full") params.set("div", d);
    return `/leagues/${leagueId}/standings?${params.toString()}`;
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Standings</h1>
          <span className="rounded-full bg-surface-tint px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            {settings.leagueType === "REDRAFT" ? "Redraft League" : "Dynasty League"}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {bracketSize > 0 && (
            <Link href={`/leagues/${leagueId}/standings/bracket?season=${season}`} className="text-sm font-medium text-blue hover:underline">
              Projected Playoff Bracket →
            </Link>
          )}
          <SeasonSelect leagueId={leagueId} season={season} div={div} availableSeasons={availableSeasons} />
        </div>
      </div>

      {!hasSchedule ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
        </Card>
      ) : (
        <>
          {hasDivisions && (
            <div className="mt-6 flex gap-5 border-b border-border">
              <Link
                href={tabHref("Full")}
                className={`border-b-2 px-1 pb-2 text-sm font-medium ${div === "Full" ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
              >
                Full
              </Link>
              {divisionNames.map((d) => (
                <Link
                  key={d}
                  href={tabHref(d)}
                  className={`border-b-2 px-1 pb-2 text-sm font-medium ${div === d ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
                >
                  {d}
                </Link>
              ))}
            </div>
          )}
          {!hasDivisions && (
            <div className="mt-6">
              <SectionLabel>Full</SectionLabel>
            </div>
          )}

          <div className={hasDivisions ? "mt-4" : ""}>
            <StandingsTable
              rows={visibleStandings}
              leagueId={leagueId}
              myTeamId={myTeam?.id ?? null}
              bracketSize={bracketSize}
              totalTeams={standings.length}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            Only completed weeks count toward the record — a week in progress isn&apos;t final yet. Playoff results
            don&apos;t affect this table. Playoff % is a rough estimate based on current standing, not a full
            simulation.
          </p>

          <div className="mt-8">
            <SectionLabel>Season Stats</SectionLabel>
            <SeasonStatsTable rows={seasonStatsRows} leagueId={leagueId} />
          </div>
        </>
      )}

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
