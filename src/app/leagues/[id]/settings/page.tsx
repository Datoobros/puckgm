import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { EDITABLE_SCORING_FIELDS } from "@/lib/scoring/engine";
import { updateLeagueSettingsAction } from "@/app/leagues/actions";
import { Card, SectionLabel } from "@/components/Card";

export default async function LeagueSettingsPage(props: PageProps<"/leagues/[id]/settings">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const commissioner = await getLeagueCommissioner(leagueId);
  const settings = league.settingsJson as unknown as LeagueSettings;

  if (commissioner !== userId) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-sm text-zinc-500">Only the league commissioner can view or change settings.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-zinc-500 hover:underline">
        ← {league.name}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">League Settings</h1>

      <Card className="mt-4 !bg-amber-500/5 !border-amber-500/20">
        <p className="text-xs text-amber-700 dark:text-amber-400">
          DESIGN.md §2.10: these settings are meant to change <strong>between seasons, by league
          vote</strong> — not mid-season, and not unilaterally, since they affect real asset value
          (a farm-slot cut devalues prospects people traded picks for). This app has no voting
          system yet, so nothing stops you from saving a change right now — that&apos;s on you and
          your league, not enforced here.
        </p>
      </Card>

      <div className="mt-6">
        <SectionLabel>Locked forever</SectionLabel>
        <Card>
          <p className="text-xs text-zinc-500">Roster composition, league size, and scoring format never change once the league is created.</p>
          <p className="mt-2 text-sm">
            {Object.entries(settings.rosterComposition)
              .map(([slot, count]) => `${count} ${slot}`)
              .join(" · ")}
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            {settings.leagueSize}-team league · {settings.scoringFormat.replace("_", " ")}
          </p>
        </Card>
      </div>

      <form action={updateLeagueSettingsAction.bind(null, leagueId)} className="mt-6 space-y-6">
        <div>
          <SectionLabel>Roster limits</SectionLabel>
          <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <label className="block">
              <span className="text-xs text-zinc-500">Farm slots</span>
              <input
                name="farmSlots"
                type="number"
                min={0}
                defaultValue={settings.farmSlots}
                className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">IR slots</span>
              <input
                name="irSlots"
                type="number"
                min={0}
                defaultValue={settings.irSlots}
                className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">Waiver GP threshold</span>
              <input
                name="waiverGpThreshold"
                type="number"
                min={0}
                defaultValue={settings.waiverGpThreshold}
                className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">Callups / week</span>
              <input
                name="callupsPerWeek"
                type="number"
                min={0}
                defaultValue={settings.callupsPerWeek}
                className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
            </label>
          </Card>
        </div>

        <div>
          <SectionLabel>FAAB / the wire</SectionLabel>
          <Card>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="faabEnabled" defaultChecked={settings.faabEnabled} className="h-4 w-4" />
              Use FAAB for free-agent pickups
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              Off by default — with no draft feature yet, free instant Add is how a new league
              builds its roster. Turn this on once your league wants pickups to cost a bid instead.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-xs text-zinc-500">Budget (per season)</span>
                <input
                  name="faabBudget"
                  type="number"
                  min={0}
                  defaultValue={settings.faabBudget}
                  className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-500">Minimum bid</span>
                <input
                  name="faabMinBid"
                  type="number"
                  min={0}
                  defaultValue={settings.faabMinBid}
                  className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-500">Maximum bid (blank = no cap)</span>
                <input
                  name="faabMaxBid"
                  type="number"
                  min={0}
                  defaultValue={settings.faabMaxBid ?? ""}
                  className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
              </label>
            </div>
          </Card>
        </div>

        <div>
          <SectionLabel>Scoring</SectionLabel>
          <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {EDITABLE_SCORING_FIELDS.map(({ key, label }) => (
              <label key={key} className="block">
                <span className="text-xs text-zinc-500">{label}</span>
                <input
                  name={`scoring_${key}`}
                  type="number"
                  step="any"
                  defaultValue={settings.scoringConfig[key] ?? 0}
                  className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
              </label>
            ))}
          </Card>
        </div>

        <button type="submit" className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background">
          Save settings
        </button>
      </form>
    </div>
  );
}
