import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner } from "@/lib/leagues/mutations";
import { getUserDisplayName } from "@/lib/users/display";
import { setCoCommissionersAction } from "@/app/leagues/actions";
import { Card } from "@/components/Card";
import { Button, Badge } from "@/components/Button";

export default async function PowersPage(props: PageProps<"/leagues/[id]/settings/powers">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const primaryCommissioner = await getLeagueCommissioner(leagueId);
  const isPrimary = primaryCommissioner === userId;

  const teams = await Promise.all(
    league.teams.map(async (t) => ({
      id: t.id,
      name: t.name,
      managerName: await getUserDisplayName(t.managerUserId),
      isCoCommissioner: t.isCoCommissioner,
      isPrimary: t.managerUserId === primaryCommissioner,
    })),
  );

  return (
    <div>
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Assign League Manager Powers</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Co-commissioners can do everything the primary commissioner can — change settings, run roster
        moves as League Manager, veto or force trades.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      {!isPrimary && (
        <Card className="mt-4 !border-warning/20 !bg-warning-tint">
          <p className="text-xs text-warning">Only the primary commissioner can change LM powers.</p>
        </Card>
      )}

      <Card className="mt-6">
        <form action={setCoCommissionersAction.bind(null, leagueId)} className="space-y-3">
          <ul className="divide-y divide-border">
            {teams.map((team) => (
              <li key={team.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{team.name}</span>
                  <span className="text-xs text-muted">{team.managerName}</span>
                  {team.isPrimary && <Badge tone="gold">Primary commissioner</Badge>}
                </div>
                {team.isPrimary ? (
                  <span className="text-xs text-muted">Always full access</span>
                ) : (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      name={`cocomm_${team.id}`}
                      defaultChecked={team.isCoCommissioner}
                      disabled={!isPrimary}
                      className="h-3.5 w-3.5"
                    />
                    Co-commissioner
                  </label>
                )}
              </li>
            ))}
          </ul>
          {isPrimary && (
            <div className="pt-2">
              <Button type="submit" variant="primary" size="sm">
                Save
              </Button>
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}
