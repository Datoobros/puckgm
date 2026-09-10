import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague } from "@/lib/leagues/mutations";
import { getTeamRosterView } from "@/lib/rosters/mutations";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { TeamLogo } from "@/components/TeamLogo";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Button";

const TIER_LABELS: Record<"ACTIVE" | "FARM" | "IR", string> = {
  ACTIVE: "Active",
  FARM: "Farm",
  IR: "IR",
};

/** Every team's full roster (Active + Farm + IR) on one page, side by side —
 * the ESPN "League Rosters" view. Position shown is each player's real
 * primaryPosition, not a live lineup slot — this page is a roster overview
 * across the whole league, not a day-to-day lineup tool (that's the team
 * page's job). No "ACQ" (how acquired) column — this app has no cheap,
 * pre-aggregated per-slot acquisition source, and adding one just for this
 * overview page wasn't worth the extra query weight per team. */
export default async function LeagueRostersPage(props: PageProps<"/leagues/[id]/teams/rosters">) {
  await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const rosters = await Promise.all(
    league.teams.map(async (team) => ({
      team,
      slots: await getTeamRosterView(team.id),
    })),
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/teams`} className="text-sm text-muted hover:underline">
        ← Teams
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">League Rosters</h1>
      <p className="mt-1 text-sm text-muted">Every team&apos;s active roster, farm, and IR in one place.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rosters.map(({ team, slots }) => (
          <Card key={team.id} className="!p-0 overflow-hidden">
            <Link
              href={`/leagues/${leagueId}/teams/${team.id}`}
              className="flex items-center gap-2 border-b border-border bg-surface-tint px-4 py-3 hover:opacity-90"
            >
              <TeamLogo url={team.logoUrl} alt={team.name} size={28} />
              <span className="font-medium">{team.name}</span>
            </Link>
            <div className="divide-y divide-border">
              {(["ACTIVE", "FARM", "IR"] as const).map((tier) => {
                const tierSlots = slots.filter((s) => s.slotType === tier);
                return (
                  <div key={tier} className="px-4 py-2">
                    <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {TIER_LABELS[tier]} ({tierSlots.length})
                    </p>
                    {tierSlots.length === 0 ? (
                      <p className="py-1 text-xs text-muted">Empty</p>
                    ) : (
                      <ul>
                        {tierSlots.map((s) => (
                          <li key={s.id} className="flex items-center gap-2 py-1 text-sm">
                            <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={22} />
                            <span className="w-6 shrink-0 text-xs text-muted">{s.player.primaryPosition ?? "—"}</span>
                            <span className="truncate">{s.player.fullName}</span>
                            {s.player.officialRosterStatus === "IR" && tier !== "IR" && (
                              <Badge tone="danger" className="ml-auto shrink-0">IR</Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
