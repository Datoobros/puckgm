import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeagueByInviteCode, isTeamManager } from "@/lib/leagues/mutations";
import { Card } from "@/components/Card";
import { joinLeagueAction } from "../actions";

export default async function InvitePage(props: PageProps<"/invite/[code]">) {
  const { userId } = await auth.protect();
  const { code } = await props.params;

  const league = await getLeagueByInviteCode(code);
  if (!league) notFound();

  const alreadyMember = league.teams.some((t) => isTeamManager(t, userId));

  return (
    <div className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Join {league.name}</h1>

      {alreadyMember ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">You&apos;re already a member of this league.</p>
          <Link href={`/leagues/${league.id}`} className="mt-2 inline-block text-sm underline">
            Go to the league →
          </Link>
        </Card>
      ) : (
        <Card className="mt-6">
          <form action={joinLeagueAction.bind(null, code)} className="flex gap-2">
            <input
              name="teamName"
              required
              placeholder="Your team name"
              className="flex-1 rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
            <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground">
              Join
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
