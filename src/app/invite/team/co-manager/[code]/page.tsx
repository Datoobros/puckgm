import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getTeamByCoManagerClaimCode } from "@/lib/leagues/mutations";
import { Card } from "@/components/Card";
import { claimCoManagerAction } from "../../../actions";

export default async function ClaimCoManagerPage(props: PageProps<"/invite/team/co-manager/[code]">) {
  const { userId } = await auth.protect();
  const { code } = await props.params;

  const team = await getTeamByCoManagerClaimCode(code);
  if (!team) notFound();

  const isPrimary = team.managerUserId === userId;
  const isAlreadyCoManager = team.secondManagerUserId === userId;

  return (
    <div className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Co-manage &quot;{team.name}&quot;</h1>
      <p className="mt-1 text-sm text-muted">in {team.league.name}</p>

      {isPrimary ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">You already manage this team.</p>
        </Card>
      ) : isAlreadyCoManager ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">You&apos;re already this team&apos;s co-manager.</p>
        </Card>
      ) : (
        <Card className="mt-6">
          <p className="mb-3 text-sm text-muted">
            Full control of this team&apos;s roster, lineup, waivers, FAAB, trades, and draft
            picks — shared with its primary manager.
          </p>
          <form action={claimCoManagerAction.bind(null, code)}>
            <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground">
              Become co-manager
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
