import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague } from "@/lib/leagues/mutations";
import { DeleteLeagueButton } from "@/components/DeleteLeagueButton";
import { Card } from "@/components/Card";

export default async function DeleteLeaguePage(props: PageProps<"/leagues/[id]/settings/delete">) {
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  return (
    <div>
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Delete League</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Permanently delete this league and all of its data — every team, roster, trade, draft, and
        schedule. This can&apos;t be undone.
      </p>

      <Card className="mt-6 !border-danger/20 !bg-danger-tint">
        <DeleteLeagueButton leagueId={league.id} leagueName={league.name} />
      </Card>
    </div>
  );
}
