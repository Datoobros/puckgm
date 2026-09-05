import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner, type LeagueSettings } from "@/lib/leagues/mutations";
import { EDITABLE_SCORING_FIELDS } from "@/lib/scoring/engine";
import { updateLeagueSettingsAction, generateScheduleAction } from "@/app/leagues/actions";
import { DeleteLeagueButton } from "@/components/DeleteLeagueButton";
import { Card, SectionLabel } from "@/components/Card";
import { prisma } from "@/lib/db";
import { CURRENT_SCHEDULE_SEASON, DEFAULT_SEASON_START } from "@/lib/matchups/constants";

export default async function LeagueSettingsPage(props: PageProps<"/leagues/[id]/settings">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const commissioner = await getLeagueCommissioner(leagueId);
  const settings = league.settingsJson as unknown as LeagueSettings;

  if (commissioner !== userId) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-sm text-muted">Only the league commissioner can view or change settings.</p>
      </div>
    );
  }

  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId, season: CURRENT_SCHEDULE_SEASON } })) > 0;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href={`/leagues/${leagueId}`} className="text-sm text-muted hover:underline">
        ← {league.name}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Commissioner Settings</h1>

      {justSaved && (
        <Card className="mt-4 !bg-emerald-500/10 !border-emerald-500/20">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Settings saved.</p>
        </Card>
      )}

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
          <p className="text-xs text-muted">Roster composition, league size, and scoring format never change once the league is created.</p>
          <p className="mt-2 text-sm">
            {Object.entries(settings.rosterComposition)
              .map(([slot, count]) => `${count} ${slot}`)
              .join(" · ")}
          </p>
          <p className="mt-1 text-sm text-muted">
            {settings.leagueSize}-team league · {settings.scoringFormat.replace("_", " ")}
          </p>
        </Card>
      </div>

      <form action={updateLeagueSettingsAction.bind(null, leagueId)} className="mt-6 space-y-6">
        <div>
          <SectionLabel>Roster limits</SectionLabel>
          <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
        </div>

        <div>
          <SectionLabel>FAAB / the wire</SectionLabel>
          <Card>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="faabEnabled" defaultChecked={settings.faabEnabled} className="h-4 w-4" />
              Use FAAB for free-agent pickups
            </label>
            <p className="mt-1 text-xs text-muted">
              Off by default — with no draft feature yet, free instant Add is how a new league
              builds its roster. Turn this on once your league wants pickups to cost a bid instead.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-xs text-muted">Budget (per season)</span>
                <input
                  name="faabBudget"
                  type="number"
                  min={0}
                  defaultValue={settings.faabBudget}
                  className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Minimum bid</span>
                <input
                  name="faabMinBid"
                  type="number"
                  min={0}
                  defaultValue={settings.faabMinBid}
                  className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Maximum bid (blank = no cap)</span>
                <input
                  name="faabMaxBid"
                  type="number"
                  min={0}
                  defaultValue={settings.faabMaxBid ?? ""}
                  className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue"
                />
              </label>
            </div>
          </Card>
        </div>

        <div>
          <SectionLabel>Trades</SectionLabel>
          <Card>
            <label className="block">
              <span className="text-xs text-muted">Who can veto a trade</span>
              <select
                name="tradeVetoMode"
                defaultValue={settings.tradeVetoMode}
                className="mt-1 block w-full max-w-xs rounded border border-border bg-white px-2 py-1.5 text-sm text-black"
              >
                <option value="COMMISSIONER">Commissioner only</option>
                <option value="VOTE">League vote (majority of managers not in the trade)</option>
              </select>
            </label>
          </Card>
        </div>

        <div>
          <SectionLabel>Trade deadline</SectionLabel>
          <p className="mb-3 text-xs text-muted">
            DESIGN.md §2.10 treats this as an &quot;anytime&quot; setting, not a between-seasons
            one — the commissioner can move it whenever. It only blocks new proposals after the
            date; trades already in flight aren&apos;t affected.
          </p>
          <Card>
            <label className="block max-w-xs">
              <span className="text-xs text-muted">No new trades after (blank = no deadline)</span>
              <input
                name="tradeDeadline"
                type="date"
                defaultValue={settings.tradeDeadline ?? ""}
                className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-sm text-black"
              />
            </label>
          </Card>
        </div>

        <div>
          <SectionLabel>Scoring</SectionLabel>
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
        </div>

        <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground">
          Save settings
        </button>
      </form>

      <div className="mt-10">
        <SectionLabel>Schedule</SectionLabel>
        <Card>
          {hasSchedule ? (
            <p className="text-sm text-muted">
              {CURRENT_SCHEDULE_SEASON}-{(CURRENT_SCHEDULE_SEASON + 1) % 100} schedule generated —
              see Scoreboard / Standings.
            </p>
          ) : (
            <form action={generateScheduleAction.bind(null, leagueId)} className="space-y-2">
              <p className="text-xs text-muted">
                Generate a round-robin schedule for the {CURRENT_SCHEDULE_SEASON}-
                {(CURRENT_SCHEDULE_SEASON + 1) % 100} season. One-time — can&apos;t be
                regenerated once created.
              </p>
              <input type="hidden" name="season" value={CURRENT_SCHEDULE_SEASON} />
              <label className="block text-xs text-muted">
                Start date
                <input
                  type="date"
                  name="startDate"
                  defaultValue={DEFAULT_SEASON_START}
                  required
                  className="mt-1 block w-full rounded border border-border bg-white px-2 py-1 text-sm text-black"
                />
              </label>
              <label className="block text-xs text-muted">
                Weeks
                <input
                  type="number"
                  name="weekCount"
                  defaultValue={24}
                  min={1}
                  required
                  className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                />
              </label>
              <button
                type="submit"
                className="mt-1 rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint"
              >
                Generate Schedule
              </button>
            </form>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <SectionLabel>Danger zone</SectionLabel>
        <Card>
          <DeleteLeagueButton leagueId={league.id} leagueName={league.name} />
        </Card>
      </div>
    </div>
  );
}
