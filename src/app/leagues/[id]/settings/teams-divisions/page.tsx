import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague } from "@/lib/leagues/mutations";
import { saveTeamsAndDivisionsAction } from "@/app/leagues/actions";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";

export default async function TeamsAndDivisionsPage(props: PageProps<"/leagues/[id]/settings/teams-divisions">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();

  return (
    <div>
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Edit Teams and Divisions</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Rename any team, or group teams into divisions — display and standings only, schedule and
        playoff seeding are unaffected.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      <Card className="mt-6 !p-0">
        <form action={saveTeamsAndDivisionsAction.bind(null, leagueId)}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Team</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Division</th>
              </tr>
            </thead>
            <tbody>
              {league.teams.map((team) => (
                <tr key={team.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-muted">{team.name}</td>
                  <td className="px-4 py-3">
                    <input
                      name={`name_${team.id}`}
                      defaultValue={team.name}
                      className="w-full max-w-xs rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-blue"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      name={`division_${team.id}`}
                      defaultValue={team.division ?? ""}
                      placeholder="(none)"
                      className="w-full max-w-xs rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-blue"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-4">
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
