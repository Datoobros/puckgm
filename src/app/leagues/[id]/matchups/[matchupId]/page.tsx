import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getMatchupDetail, type MatchupDetailSide } from "@/lib/matchups/standings";
import { formatPeriodRange } from "@/lib/dates";
import { Card } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { teamInitials } from "@/lib/teams/initials";

export default async function MatchupDetailPage(props: PageProps<"/leagues/[id]/matchups/[matchupId]">) {
  await auth.protect();
  const { id: leagueId, matchupId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const belongsToLeague = await prisma.matchup.findFirst({
    where: { id: matchupId, matchupPeriod: { leagueId } },
    select: { id: true },
  });
  if (!belongsToLeague) notFound();

  const detail = await getMatchupDetail(matchupId, settings.scoringConfig);
  if (!detail) notFound();

  const range = formatPeriodRange(detail.startDate, detail.endDate);
  const weekLabel = detail.isPlayoffs ? detail.roundLabel : `Matchup ${detail.periodNo}`;
  const statusLabel = detail.final ? "Final" : "In progress";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/scoreboard?week=${detail.periodNo}`} className="text-sm text-muted hover:underline">
        ← Scoreboard
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {detail.home.name} vs {detail.away.name}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {weekLabel} · {range} · {statusLabel}
      </p>

      <Card className="mt-6">
        <div className="grid grid-cols-2 gap-4">
          <ScoreColumn side={detail.home} final={detail.final} otherScore={detail.away.score} />
          <ScoreColumn side={detail.away} final={detail.final} otherScore={detail.home.score} />
        </div>
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlayerTable side={detail.home} />
        <PlayerTable side={detail.away} />
      </div>
    </div>
  );
}

function ScoreColumn({ side, final, otherScore }: { side: MatchupDetailSide; final: boolean; otherScore: number }) {
  const trailing = final && side.score < otherScore;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <TeamLogo url={side.logoUrl} alt={side.name} size={56} />
      <div className="text-sm font-medium">
        {side.seed !== null && <span className="text-muted">({side.seed}) </span>}
        {side.name}
      </div>
      <div className={`text-4xl font-bold tabular-nums ${trailing ? "text-muted" : ""}`}>{side.score.toFixed(1)}</div>
    </div>
  );
}

function PlayerTable({ side }: { side: MatchupDetailSide }) {
  return (
    <Card className="overflow-x-auto !p-0">
      <div className="border-b border-border px-4 py-3">
        <span className="font-medium">{side.name}</span>
        <span className="ml-2 text-xs text-muted">{teamInitials(side.name)}</span>
      </div>
      {side.adjustments.length > 0 && (
        <div className="border-b border-border px-4 py-2 text-xs text-muted">
          Adjustments:{" "}
          {side.adjustments
            .map((a) => `${a.points > 0 ? "+" : ""}${a.points.toFixed(1)}${a.reason ? ` (${a.reason})` : ""}`)
            .join(", ")}
        </div>
      )}
      {side.players.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">No lineup set for this week yet.</p>
      ) : (
        <table className="w-full min-w-[320px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-2 pl-4 pr-2 font-medium">Player</th>
              <th className="py-2 pr-2 text-right font-medium">GS</th>
              <th className="py-2 pr-4 text-right font-medium">PTS</th>
            </tr>
          </thead>
          <tbody>
            {side.players.map((p) => (
              <tr key={p.playerId} className="border-b border-border last:border-0">
                <td className="py-2 pl-4 pr-2">
                  <div className="flex items-center gap-2">
                    <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={28} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{p.fullName}</div>
                      <div className="text-xs text-muted">
                        {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{p.gamesStarted}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{p.points.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2 pl-4 pr-2 font-semibold">Total</td>
              <td className="py-2 pr-2" />
              <td className="py-2 pr-4 text-right font-semibold tabular-nums">{side.score.toFixed(1)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </Card>
  );
}
