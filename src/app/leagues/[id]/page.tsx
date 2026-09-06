import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager, type LeagueSettings } from "@/lib/leagues/mutations";
import { getClaimablePlayers, getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { getRecentActivity } from "@/lib/activity/feed";
import { getStandings } from "@/lib/matchups/standings";
import { Card, SectionLabel } from "@/components/Card";
import { submitWaiverClaimAction, cancelWaiverClaimAction } from "./waivers/actions";

function hoursRemaining(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "processing soon";
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours <= 1 ? "< 1 hour left" : `${hours} hours left`;
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const DOT_COLOR: Record<string, string> = {
  WAIVER: "bg-gold",
  FAAB: "bg-gold",
  TRADE: "bg-blue",
};

export default async function LeagueDetailPage(props: PageProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const settings = league.settingsJson as unknown as LeagueSettings;
  const yourTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;

  const [activity, claimable, priorityOrder, standings] = await Promise.all([
    getRecentActivity(id),
    getClaimablePlayers(id, yourTeam?.id ?? null),
    getOrInitWaiverPriority(id),
    getStandings(id, league.currentSeason, settings.scoringConfig),
  ]);
  const teamNameById = new Map(league.teams.map((t) => [t.id, t.name]));

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{league.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {league.seasonFounded} season · {settings.scoringFormat.replace("_", " ")}
          </p>
        </div>
      </div>

      {!yourTeam && (
        <Card className="mt-6">
          <p className="text-sm text-muted">
            You&apos;re not a member of this league. Ask the commissioner for an invite link to
            join.
          </p>
        </Card>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div>
            <SectionLabel>Recent activity</SectionLabel>
            {activity.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">No moves yet this season.</p>
              </Card>
            ) : (
              <Card className="!p-0 overflow-hidden">
                <ul className="divide-y divide-border">
                  {activity.map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_COLOR[a.kind]}`} />
                      <span className="flex-1">{a.text}</span>
                      <span className="shrink-0 text-xs text-muted">{timeAgo(a.timestamp)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>

          <div>
            <SectionLabel>Waivers</SectionLabel>
            <p className="mb-3 text-xs text-muted">
              A player with 80+ career NHL games can be claimed by another team for 48 hours after
              being sent to the farm. Claims resolve once daily.
            </p>
            {claimable.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">No players currently on waivers.</p>
              </Card>
            ) : (
              <Card className="!p-0 overflow-hidden">
                <ul className="divide-y divide-border">
                  {claimable.map((p) => {
                    const isMyDemotion = yourTeam?.id === p.demotingTeamId;
                    return (
                      <li key={p.rosterSlotId} className="flex items-center justify-between px-4 py-2 text-sm">
                        <span>
                          {p.playerName}
                          <span className="ml-2 text-xs text-muted">
                            {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"} · from {p.demotingTeamName}
                          </span>
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-xs text-muted">{hoursRemaining(p.waiverExpiresAt)}</span>
                          {isMyDemotion ? (
                            <span className="text-xs text-muted">your demotion</span>
                          ) : !yourTeam ? null : p.myPendingClaimId ? (
                            <form action={cancelWaiverClaimAction.bind(null, id, p.myPendingClaimId)}>
                              <button
                                type="submit"
                                className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint"
                              >
                                Claim pending · Cancel
                              </button>
                            </form>
                          ) : (
                            <form action={submitWaiverClaimAction.bind(null, id, p.playerId)}>
                              <button
                                type="submit"
                                className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint"
                              >
                                Claim
                              </button>
                            </form>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                Waiver priority order
              </summary>
              <Card className="!p-0 mt-2 overflow-hidden">
                <ol className="divide-y divide-border">
                  {priorityOrder.map((teamId, i) => (
                    <li key={teamId} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-5 text-muted tabular-nums">{i + 1}</span>
                      <span className={teamId === yourTeam?.id ? "font-medium" : ""}>
                        {teamNameById.get(teamId) ?? "Unknown team"}
                        {teamId === yourTeam?.id && <span className="ml-2 text-xs text-muted">(you)</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            </details>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <SectionLabel>Standings</SectionLabel>
            <Card className="!p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="py-2 pl-4 pr-2 text-xs font-medium">Team</th>
                    <th className="py-2 pr-2 text-right text-xs font-medium">W</th>
                    <th className="py-2 pr-4 text-right text-xs font-medium">L</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.slice(0, 5).map((row) => (
                    <tr key={row.teamId} className="border-b border-border last:border-0">
                      <td className="py-2 pl-4 pr-2 font-medium">{row.teamName}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{row.wins}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Link
                href={`/leagues/${id}/standings`}
                className="block border-t border-border px-4 py-2 text-center text-xs text-blue hover:underline"
              >
                View full standings
              </Link>
            </Card>
          </div>

          <div>
            <SectionLabel>League Info</SectionLabel>
            <Card>
              <p className="text-xs text-muted">Roster composition (locked)</p>
              <p className="mt-1 text-sm">
                {Object.entries(settings.rosterComposition)
                  .filter(([slot, count]) => slot !== "positionMode" && count > 0)
                  .map(([slot, count]) => `${count} ${slot}`)
                  .join(" · ")}
              </p>
              <p className="mt-3 text-xs text-muted">Farm slots / IR slots</p>
              <p className="mt-1 text-sm">
                {settings.farmSlots} farm · {settings.irSlots} IR
              </p>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
