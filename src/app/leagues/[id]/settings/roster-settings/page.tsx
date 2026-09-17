import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { updateRosterSettingsAction } from "@/app/leagues/actions";
import { Button, Badge } from "@/components/Button";
import { Card, SectionLabel } from "@/components/Card";

export default async function RosterSettingsPage(props: PageProps<"/leagues/[id]/settings/roster-settings">) {
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
        <h1 className="text-2xl font-semibold tracking-tight">Edit Roster Settings</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Set farm/IR slots, the weekly callup limit, and roster composition. Forward position
        mode (separate vs. combined) is locked forever — everything else here can change
        between seasons.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      <form action={updateRosterSettingsAction.bind(null, leagueId)} className="mt-8 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel className="!mb-0">Roster limits</SectionLabel>
          <Button type="submit" variant="primary" size="sm">
            Save Settings
          </Button>
        </div>

        <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {settings.leagueType === "REDRAFT" ? (
            <input type="hidden" name="farmSlots" value={0} />
          ) : (
            <label className="block">
              <span className="text-xs text-muted">Farm slots</span>
              <input
                name="farmSlots"
                type="number"
                min={0}
                defaultValue={settings.farmSlots}
                className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-muted">IR slots</span>
            <input
              name="irSlots"
              type="number"
              min={0}
              defaultValue={settings.irSlots}
              className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Waiver GP threshold</span>
            <input
              name="waiverGpThreshold"
              type="number"
              min={0}
              defaultValue={settings.waiverGpThreshold}
              className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Callups / week</span>
            <input
              name="callupsPerWeek"
              type="number"
              min={0}
              defaultValue={settings.callupsPerWeek}
              className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
            />
          </label>
        </Card>

        <div>
          <SectionLabel>Roster composition</SectionLabel>
          <p className="mb-3 text-xs text-muted">
            No longer locked forever — forward position mode (separate vs. combined) still is,
            everything else here can change between seasons.
          </p>
          <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {settings.rosterComposition.positionMode === "SEPARATE" ? (
              <>
                <label className="block">
                  <span className="text-xs text-muted">C</span>
                  <input name="rosterC" type="number" min={0} defaultValue={settings.rosterComposition.C} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
                </label>
                <label className="block">
                  <span className="text-xs text-muted">LW</span>
                  <input name="rosterLW" type="number" min={0} defaultValue={settings.rosterComposition.LW} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
                </label>
                <label className="block">
                  <span className="text-xs text-muted">RW</span>
                  <input name="rosterRW" type="number" min={0} defaultValue={settings.rosterComposition.RW} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
                </label>
              </>
            ) : (
              <label className="block">
                <span className="text-xs text-muted">F</span>
                <input name="rosterF" type="number" min={0} defaultValue={settings.rosterComposition.F} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
              </label>
            )}
            <label className="block">
              <span className="text-xs text-muted">D</span>
              <input name="rosterD" type="number" min={0} defaultValue={settings.rosterComposition.D} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">G</span>
              <input name="rosterG" type="number" min={0} defaultValue={settings.rosterComposition.G} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">UTIL</span>
              <input name="rosterUTIL" type="number" min={0} defaultValue={settings.rosterComposition.UTIL} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Bench</span>
              <input name="rosterBENCH" type="number" min={0} defaultValue={settings.rosterComposition.BENCH} className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue" />
            </label>
          </Card>
        </div>
      </form>
    </div>
  );
}
