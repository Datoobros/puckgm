import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { EDITABLE_SCORING_FIELDS } from "@/lib/scoring/engine";
import { updateScoringSettingsAction } from "@/app/leagues/actions";
import { Button, Badge } from "@/components/Button";
import { Card, SectionLabel } from "@/components/Card";

export default async function ScoringSettingsPage(props: PageProps<"/leagues/[id]/settings/scoring">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Edit Scoring Settings</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Adjust the points awarded for each statistical category. Scoring format itself
        (H2H points) is locked at creation — only the per-stat values here can change.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      <form action={updateScoringSettingsAction.bind(null, leagueId)} className="mt-8 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel className="!mb-0">Scoring</SectionLabel>
          <Button type="submit" variant="primary" size="sm">
            Save Settings
          </Button>
        </div>
        <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {EDITABLE_SCORING_FIELDS.map(({ key, label }) => (
            <label key={key} className="block">
              <span className="text-xs text-muted">{label}</span>
              <input
                name={`scoring_${key}`}
                type="number"
                step="any"
                defaultValue={settings.scoringConfig[key] ?? 0}
                className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
              />
            </label>
          ))}
        </Card>
      </form>
    </div>
  );
}
