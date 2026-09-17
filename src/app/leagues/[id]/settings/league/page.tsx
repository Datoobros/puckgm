import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { updateLeagueGeneralSettingsAction } from "@/app/leagues/actions";
import { StartNewSeasonButton } from "@/components/StartNewSeasonButton";
import { Button, Badge } from "@/components/Button";
import { Card, SectionLabel } from "@/components/Card";

export default async function LeagueSettingsPage(props: PageProps<"/leagues/[id]/settings/league">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const currentSeason = league.currentSeason;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Edit League Settings</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Manage FAAB, trade governance, and the trade deadline — the league-wide rules that
        aren&apos;t scoring or roster shape.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      <Card className="mt-4 !border-warning/20 !bg-warning-tint">
        <p className="text-xs text-warning">
          DESIGN.md §2.10: these settings are meant to change <strong>between seasons, by league
          vote</strong> — not mid-season, and not unilaterally, since they affect real asset value
          (a farm-slot cut devalues prospects people traded picks for). This app has no voting
          system yet, so nothing stops you from saving a change right now — that&apos;s on you and
          your league, not enforced here.
        </p>
      </Card>

      <div className="mt-8">
        <SectionLabel>Locked forever</SectionLabel>
        <Card>
          <p className="text-xs text-muted">
            League size, scoring format, league type, and forward position mode never change once
            the league is created.
          </p>
          <p className="mt-2 text-sm text-muted">
            {settings.leagueSize}-team league · {settings.scoringFormat.replace("_", " ")} ·{" "}
            {settings.leagueType === "REDRAFT" ? "Redraft" : "Dynasty"}
          </p>
        </Card>
      </div>

      <form action={updateLeagueGeneralSettingsAction.bind(null, leagueId)} className="mt-8 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel className="!mb-0">FAAB / the wire</SectionLabel>
          <Button type="submit" variant="primary" size="sm">
            Save Settings
          </Button>
        </div>

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

        <div>
          <SectionLabel>Trades</SectionLabel>
          <Card>
            <label className="block">
              <span className="text-xs text-muted">Who can veto a trade</span>
              <select
                name="tradeVetoMode"
                defaultValue={settings.tradeVetoMode}
                className="mt-1 block w-full max-w-xs rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                <option value="COMMISSIONER">Commissioner only</option>
                <option value="VOTE">League vote (majority of managers not in the trade)</option>
              </select>
            </label>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="draftPickTradingEnabled"
                defaultChecked={settings.draftPickTradingEnabled !== false}
                className="h-4 w-4"
              />
              Allow draft picks to be traded
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
                className="mt-1 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              />
            </label>
          </Card>
        </div>
      </form>

      {settings.leagueType === "REDRAFT" && (
        <div className="mt-8">
          <SectionLabel>Season</SectionLabel>
          <Card className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">Current season: {currentSeason}</p>
              <p className="mt-1 text-xs text-muted">
                Empties every roster on this league back to free agency and advances to{" "}
                {currentSeason + 1} — set up a new startup draft afterward from Draft Settings.
                Any trade still pending is cancelled first.
              </p>
            </div>
            <StartNewSeasonButton leagueId={leagueId} currentSeason={currentSeason} />
          </Card>
        </div>
      )}
    </div>
  );
}
