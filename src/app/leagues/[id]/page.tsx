import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { getRosterCounts } from "@/lib/rosters/mutations";
import { createTeamAction, generateScheduleAction } from "@/app/leagues/actions";
import { DeleteLeagueButton } from "@/components/DeleteLeagueButton";
import { Card, SectionLabel } from "@/components/Card";
import { prisma } from "@/lib/db";
import { CURRENT_SCHEDULE_SEASON, DEFAULT_SEASON_START } from "@/lib/matchups/constants";

export default async function LeagueDetailPage(props: PageProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const settings = league.settingsJson as unknown as LeagueSettings;
  const yourTeam = league.teams.find((t) => t.managerUserId === userId);
  const commissioner = await getLeagueCommissioner(id);
  const rosterCounts = await getRosterCounts(league.teams.map((t) => t.id));
  const cap = Object.values(settings.rosterComposition).reduce((s, n) => s + n, 0);
  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId: id, season: CURRENT_SCHEDULE_SEASON } })) > 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-start justify-between border-b border-black/10 pb-4 dark:border-white/10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{league.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {league.seasonFounded} season · {settings.scoringFormat.replace("_", " ")}
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionLabel>Teams ({league.teams.length})</SectionLabel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {league.teams.map((team) => {
              const isYou = team.managerUserId === userId;
              const rosterCount = rosterCounts.get(team.id) ?? 0;
              return (
                <Link key={team.id} href={`/leagues/${league.id}/teams/${team.id}`}>
                  <Card
                    className={`transition-colors hover:border-black/25 dark:hover:border-white/25 ${
                      isYou ? "border-foreground/30" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{team.name}</p>
                      {isYou && (
                        <span className="rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background">
                          YOU
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      {rosterCount} / {cap} roster spots
                    </p>
                  </Card>
                </Link>
              );
            })}
          </div>

          {!yourTeam && (
            <Card className="mt-4">
              <p className="text-sm text-zinc-500">You don&apos;t have a team here yet.</p>
              <form action={createTeamAction.bind(null, league.id)} className="mt-3 flex gap-2">
                <input
                  name="teamName"
                  required
                  placeholder="Your team name"
                  className="flex-1 rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
                <button
                  type="submit"
                  className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
                >
                  Join league
                </button>
              </form>
            </Card>
          )}
        </div>

        <div>
          <SectionLabel>League Info</SectionLabel>
          <Card>
            <p className="text-xs text-zinc-500">Roster composition (locked)</p>
            <p className="mt-1 text-sm">
              {Object.entries(settings.rosterComposition)
                .map(([slot, count]) => `${count} ${slot}`)
                .join(" · ")}
            </p>
            <p className="mt-3 text-xs text-zinc-500">Farm slots / IR slots</p>
            <p className="mt-1 text-sm">
              {settings.farmSlots} farm · {settings.irSlots} IR
            </p>
          </Card>

          {commissioner === userId && (
            <div className="mt-4">
              <SectionLabel>Commissioner Tools</SectionLabel>
              <Card>
                <Link
                  href={`/leagues/${league.id}/settings`}
                  className="inline-block rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                >
                  Edit League Settings
                </Link>
                <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
                  {hasSchedule ? (
                    <p className="text-sm text-zinc-500">
                      {CURRENT_SCHEDULE_SEASON}-{(CURRENT_SCHEDULE_SEASON + 1) % 100} schedule generated —
                      see Scoreboard / Standings.
                    </p>
                  ) : (
                    <form action={generateScheduleAction.bind(null, league.id)} className="space-y-2">
                      <p className="text-xs text-zinc-500">
                        Generate a round-robin schedule for the {CURRENT_SCHEDULE_SEASON}-
                        {(CURRENT_SCHEDULE_SEASON + 1) % 100} season. One-time — can&apos;t be
                        regenerated once created.
                      </p>
                      <input type="hidden" name="season" value={CURRENT_SCHEDULE_SEASON} />
                      <label className="block text-xs text-zinc-500">
                        Start date
                        <input
                          type="date"
                          name="startDate"
                          defaultValue={DEFAULT_SEASON_START}
                          required
                          className="mt-1 block w-full rounded border border-black/10 bg-white px-2 py-1 text-sm text-black dark:border-white/15"
                        />
                      </label>
                      <label className="block text-xs text-zinc-500">
                        Weeks
                        <input
                          type="number"
                          name="weekCount"
                          defaultValue={24}
                          min={1}
                          required
                          className="mt-1 block w-full rounded border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/15"
                        />
                      </label>
                      <button
                        type="submit"
                        className="mt-1 rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                      >
                        Generate Schedule
                      </button>
                    </form>
                  )}
                </div>
                <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
                  <DeleteLeagueButton leagueId={league.id} leagueName={league.name} />
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
