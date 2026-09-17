import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, getLeagueDivisions } from "@/lib/leagues/mutations";
import { saveTeamsAndDivisionsAction, addDivisionAction, removeDivisionAction, renameDivisionAction } from "@/app/leagues/actions";
import { Card, SectionLabel } from "@/components/Card";
import { Button } from "@/components/Button";

export default async function TeamsAndDivisionsPage(props: PageProps<"/leagues/[id]/settings/teams-divisions">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const divisions = await getLeagueDivisions(leagueId);

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

      <div className="mt-8">
        <SectionLabel>Divisions</SectionLabel>
        <Card>
          {divisions.length === 0 ? (
            <p className="mb-3 text-sm text-muted">No divisions yet — add one below.</p>
          ) : (
            <ul className="mb-4 divide-y divide-border">
              {divisions.map((d) => (
                <li key={d} className="flex items-center gap-2 py-2 first:pt-0">
                  <form action={renameDivisionAction.bind(null, leagueId, d)} className="flex flex-1 items-center gap-2">
                    <input
                      name="name"
                      defaultValue={d}
                      className="w-full max-w-xs rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-blue"
                    />
                    <Button type="submit" size="sm">
                      Rename
                    </Button>
                  </form>
                  <form action={removeDivisionAction.bind(null, leagueId, d)}>
                    <Button type="submit" variant="danger" size="sm">
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={addDivisionAction.bind(null, leagueId)} className="flex items-center gap-2">
            <input
              name="newDivision"
              required
              placeholder="Add a division…"
              className="w-full max-w-xs rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-blue"
            />
            <Button type="submit" size="sm">
              Add
            </Button>
          </form>
        </Card>
      </div>

      <div className="mt-8">
        <SectionLabel>Teams</SectionLabel>
        <Card className="!p-0">
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
                      <select
                        name={`division_${team.id}`}
                        defaultValue={team.division ?? ""}
                        className="w-full max-w-xs rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
                      >
                        <option value="">None</option>
                        {divisions.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
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
    </div>
  );
}
