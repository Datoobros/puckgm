import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getTeamsForUser } from "@/lib/leagues/mutations";
import { LinkButton } from "@/components/Button";

// Players now live under a league (/leagues/[id]/players) since scoring is
// league-specific — this route just routes you there instead of being a
// dead end for old links/bookmarks.
export default async function PlayersRedirectPage() {
  const { userId } = await auth.protect();
  const teams = await getTeamsForUser(userId);

  if (teams.length === 1) {
    redirect(`/leagues/${teams[0].leagueId}/players`);
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Pick a league</h1>
      <p className="mt-2 text-sm text-muted">
        Players are viewed within a league now — each league can set its own
        scoring.
      </p>
      {teams.length === 0 ? (
        <LinkButton href="/leagues" variant="primary" className="mt-6">Browse leagues</LinkButton>
      ) : (
        <ul className="mt-6 space-y-2">
          {teams.map((t) => (
            <li key={t.id}>
              <Link href={`/leagues/${t.leagueId}/players`} className="text-sm underline">
                {t.league.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
