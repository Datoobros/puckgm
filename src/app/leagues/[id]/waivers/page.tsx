import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague } from "@/lib/leagues/mutations";
import { getClaimablePlayers, getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { submitWaiverClaimAction, cancelWaiverClaimAction } from "./actions";

function hoursRemaining(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "processing soon";
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours <= 1 ? "< 1 hour left" : `${hours} hours left`;
}

export default async function WaiversPage(props: PageProps<"/leagues/[id]/waivers">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const myTeam = league.teams.find((t) => t.managerUserId === userId) ?? null;

  const [claimable, priorityOrder] = await Promise.all([
    getClaimablePlayers(leagueId, myTeam?.id ?? null),
    getOrInitWaiverPriority(leagueId),
  ]);
  const teamNameById = new Map(league.teams.map((t) => [t.id, t.name]));

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Waivers</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Demotion waivers only (DESIGN.md §2.3) — a player with 80+ career NHL games can be claimed
        by another team for 48 hours after being sent to the farm. Claims resolve once daily.
      </p>

      <div className="mt-6">
        <SectionLabel>Claimable now</SectionLabel>
        {claimable.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">No players currently on waivers.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/5">
              {claimable.map((p) => {
                const isMyDemotion = myTeam?.id === p.demotingTeamId;
                return (
                  <li key={p.rosterSlotId} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      {p.playerName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"} · from {p.demotingTeamName}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-zinc-500">{hoursRemaining(p.waiverExpiresAt)}</span>
                      {isMyDemotion ? (
                        <span className="text-xs text-zinc-400">your demotion</span>
                      ) : !myTeam ? null : p.myPendingClaimId ? (
                        <form action={cancelWaiverClaimAction.bind(null, leagueId, p.myPendingClaimId)}>
                          <button
                            type="submit"
                            className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                          >
                            Claim pending · Cancel
                          </button>
                        </form>
                      ) : (
                        <form action={submitWaiverClaimAction.bind(null, leagueId, p.playerId)}>
                          <button
                            type="submit"
                            className="rounded-full border border-black/10 px-3 py-1 text-xs hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
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
      </div>

      <div className="mt-6">
        <SectionLabel>Waiver priority order</SectionLabel>
        <p className="mb-3 text-xs text-zinc-500">
          No draft feature exists yet, so this starts as reverse team-creation order rather than
          real reverse-draft order. Winning a claim sends that team to the back.
        </p>
        <Card className="!p-0 overflow-hidden">
          <ol className="divide-y divide-black/5 dark:divide-white/5">
            {priorityOrder.map((teamId, i) => (
              <li key={teamId} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-5 text-zinc-400 tabular-nums">{i + 1}</span>
                <span className={teamId === myTeam?.id ? "font-medium" : ""}>
                  {teamNameById.get(teamId) ?? "Unknown team"}
                  {teamId === myTeam?.id && <span className="ml-2 text-xs text-zinc-500">(you)</span>}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
