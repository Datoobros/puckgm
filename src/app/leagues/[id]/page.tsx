import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { createTeamAction } from "@/app/leagues/actions";

export default async function LeagueDetailPage(props: PageProps<"/leagues/[id]">) {
  const { userId } = await auth.protect();
  const { id } = await props.params;

  const league = await getLeague(id);
  if (!league) notFound();

  const settings = league.settingsJson as unknown as LeagueSettings;
  const yourTeam = league.teams.find((t) => t.managerUserId === userId);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{league.name}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {league.seasonFounded} season · {settings.scoringFormat.replace("_", " ")}
      </p>

      <div className="mt-6 rounded border border-black/10 p-4 text-sm dark:border-white/10">
        <p className="text-zinc-500">Roster composition (locked)</p>
        <p className="mt-1">
          {Object.entries(settings.rosterComposition)
            .map(([slot, count]) => `${count} ${slot}`)
            .join(" · ")}
        </p>
        <p className="mt-3 text-zinc-500">Farm slots / IR slots</p>
        <p className="mt-1">
          {settings.farmSlots} farm · {settings.irSlots} IR
        </p>
      </div>

      <h2 className="mt-8 mb-2 text-sm font-medium text-zinc-500">
        Teams ({league.teams.length})
      </h2>
      <ul className="divide-y divide-black/10 dark:divide-white/10">
        {league.teams.map((team) => (
          <li key={team.id} className="py-2 text-sm">
            {team.name}
            {team.managerUserId === userId && (
              <span className="ml-2 text-xs text-zinc-500">(you)</span>
            )}
          </li>
        ))}
      </ul>

      {!yourTeam && (
        <div className="mt-8 rounded border border-black/10 p-4 dark:border-white/10">
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
        </div>
      )}
    </div>
  );
}
