import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getTeamByClaimCode, isTeamManager } from "@/lib/leagues/mutations";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { claimTeamAction } from "../../actions";

export default async function ClaimTeamPage(props: PageProps<"/invite/team/[code]">) {
  const { userId } = await auth.protect();
  const { code } = await props.params;

  const team = await getTeamByClaimCode(code);
  if (!team) notFound();

  const alreadyManages = isTeamManager(team, userId);

  return (
    <div className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Claim &quot;{team.name}&quot;</h1>
      <p className="mt-1 text-sm text-muted">in {team.league.name}</p>

      {alreadyManages ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">You already manage this team.</p>
        </Card>
      ) : (
        <Card className="mt-6">
          <form action={claimTeamAction.bind(null, code)}>
            <Button type="submit" variant="primary">Claim this team</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
