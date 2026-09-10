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
import { LinkButton } from "@/components/Button";
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
            <LinkButton
              href={`/leagues/${leagueId}/scoreboard?week=${Math.max(1, scoreboard.periodNo - 1)}`}
              size="sm"
              className={scoreboard.periodNo <= 1 ? "pointer-events-none opacity-30" : ""}
            >
              ← Prev
            </LinkButton>
            <span className="text-sm text-muted">
              {scoreboard.isPlayoffs && <span className="font-medium text-gold">{scoreboard.roundLabel} · </span>}
              Week {scoreboard.periodNo} of {periodCount}
              {" · "}
              {scoreboard.startDate.toISOString().slice(0, 10)} – {scoreboard.endDate.toISOString().slice(0, 10)}
              {" · "}
              {scoreboard.matchups.some((m) => m.final) ? "Final" : "In progress"}
            </span>
            <LinkButton
              href={`/leagues/${leagueId}/scoreboard?week=${Math.min(periodCount, scoreboard.periodNo + 1)}`}
              size="sm"
              className={scoreboard.periodNo >= periodCount ? "pointer-events-none opacity-30" : ""}
            >
              Next →
            </LinkButton>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {scoreboard.matchups.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">Bye week for every team, or nothing scheduled.</p>
              </Card>
            ) : (
              scoreboard.matchups.map((m) => (
                <MatchupCard
                  key={m.matchupId}
                  home={{ name: m.homeTeamName, logoUrl: m.homeTeamLogoUrl, seed: m.homeSeed, score: m.homeScore, topScorers: m.homeTopScorers }}
                  away={{ name: m.awayTeamName, logoUrl: m.awayTeamLogoUrl, seed: m.awaySeed, score: m.awayScore, topScorers: m.awayTopScorers }}
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
  name: string;
  logoUrl: string | null;
  seed: number | null;
  score: number;
  topScorers: TopScorer[];
}

/** Horizontal side-by-side matchup card — home team left, away team right,
 * flanking a centered score, matching ESPN's actual scoreboard layout
 * (this app previously stacked home-over-away instead). Top scorers are
 * real fantasy points scored within the period so far, not "Projected
 * Leaders" like ESPN's — this app has no stat-projection data source, so
 * that's honestly labeled as what it actually is. */
function MatchupCard({ home, away }: { home: MatchupSide; away: MatchupSide }) {
  const homeWinning = home.score >= away.score;
  const awayWinning = away.score >= home.score;
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <MatchupTeamColumn side={home} winning={homeWinning} align="left" />
        <div className="flex shrink-0 items-center gap-2 px-1">
          <span className={`tabular-nums text-lg ${homeWinning ? "font-semibold" : "text-muted"}`}>{home.score.toFixed(1)}</span>
          <span className="text-xs text-muted">–</span>
          <span className={`tabular-nums text-lg ${awayWinning ? "font-semibold" : "text-muted"}`}>{away.score.toFixed(1)}</span>
        </div>
        <MatchupTeamColumn side={away} winning={awayWinning} align="right" />
      </div>
    </Card>
  );
}

function MatchupTeamColumn({ side, winning, align }: { side: MatchupSide; winning: boolean; align: "left" | "right" }) {
  const isRight = align === "right";
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${isRight ? "flex-row-reverse text-right" : ""}`}>
      <TeamLogo url={side.logoUrl} alt={side.name} size={36} />
      <div className="min-w-0">
        <div className={`truncate text-sm ${winning ? "font-semibold" : ""}`}>
          {side.seed !== null && <span className="text-muted">({side.seed}) </span>}
          {side.name}
        </div>
        {side.topScorers.length > 0 && (
          <div className={`mt-1 flex flex-wrap items-center gap-2 ${isRight ? "justify-end" : ""}`}>
            {side.topScorers.map((p) => (
              <div key={p.playerId} className={`flex shrink-0 items-center gap-1 ${isRight ? "flex-row-reverse" : ""}`} title={p.fullName}>
                <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={18} />
                <span className="text-[11px] text-muted">
                  {p.fullName.split(" ").slice(-1)[0]} {p.points.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
