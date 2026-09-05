import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, getLeagueCommissioner, isLeagueCommissioner, teamHasHistory, type LeagueSettings } from "@/lib/leagues/mutations";
import { EDITABLE_SCORING_FIELDS } from "@/lib/scoring/engine";
import { updateLeagueSettingsAction, generateScheduleAction, regenerateInviteCodeAction } from "@/app/leagues/actions";
import { startDraftAction, resetDraftPickOwnershipAction } from "../draft/actions";
import { DeleteLeagueButton } from "@/components/DeleteLeagueButton";
import { StartNewSeasonButton } from "@/components/StartNewSeasonButton";
import { ResetScheduleButton } from "@/components/ResetScheduleButton";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { DraftSetupForm } from "./DraftSetupForm";
import { DraftSetupEditForm } from "./DraftSetupEditForm";
import { TeamManagementCard } from "./TeamManagementCard";
import { Card, SectionLabel } from "@/components/Card";
import { prisma } from "@/lib/db";
import { DEFAULT_SEASON_START } from "@/lib/matchups/constants";

export default async function LeagueSettingsPage(props: PageProps<"/leagues/[id]/settings">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const primaryCommissioner = await getLeagueCommissioner(leagueId);
  const isPrimaryCommissioner = primaryCommissioner === userId;
  const settings = league.settingsJson as unknown as LeagueSettings;

  if (!(await isLeagueCommissioner(leagueId, userId))) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-sm text-muted">Only the league commissioner can view or change settings.</p>
      </div>
    );
  }

  const currentSeason = league.currentSeason;
  const hasSchedule =
    (await prisma.matchupPeriod.count({ where: { leagueId, season: currentSeason } })) > 0;

  const drafts = await prisma.draft.findMany({ where: { leagueId }, orderBy: { createdAt: "desc" } });
  const draftPickCounts = await prisma.draftPick.groupBy({
    by: ["draftId"],
    where: { draftId: { in: drafts.map((d) => d.id) } },
    _count: { _all: true },
  });
  const pickCountByDraftId = new Map(draftPickCounts.map((g) => [g.draftId, g._count._all]));

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const inviteUrl = league.inviteCode ? `${origin}/invite/${league.inviteCode}` : null;

  const teamsWithHistory = await Promise.all(
    league.teams.map(async (t) => ({
      id: t.id,
      name: t.name,
      managerUserId: t.managerUserId,
      state: t.state,
      isCoCommissioner: t.isCoCommissioner,
      division: t.division,
      claimCode: t.claimCode,
      hasHistory: await teamHasHistory(t.id),
    })),
  );

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
          <p className="text-xs text-muted">Roster composition, league size, scoring format, and league type never change once the league is created.</p>
          <p className="mt-2 text-sm">
            {Object.entries(settings.rosterComposition)
              .filter(([slot, count]) => slot !== "positionMode" && count > 0)
              .map(([slot, count]) => `${count} ${slot}`)
              .join(" · ")}
          </p>
          <p className="mt-1 text-sm text-muted">
            {settings.leagueSize}-team league · {settings.scoringFormat.replace("_", " ")} ·{" "}
            {settings.leagueType === "REDRAFT" ? "Redraft" : "Dynasty"}
          </p>
        </Card>
      </div>

      <form action={updateLeagueSettingsAction.bind(null, leagueId)} className="mt-6 space-y-6">
        <div>
          <SectionLabel>Roster limits</SectionLabel>
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
        </div>

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
        <SectionLabel>Draft</SectionLabel>
        <Card>
          {drafts.length > 0 && (
            <ul className="mb-4 divide-y divide-border">
              {drafts.map((d) => (
                <li key={d.id} className="py-2 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">
                      {d.season} {d.type === "STARTUP" ? "Startup" : "Rookie"} draft —{" "}
                      <span className="text-xs text-muted">{d.status.replace("_", " ")}</span>
                    </span>
                    {d.status === "SETUP" && (
                      <form action={startDraftAction.bind(null, leagueId, d.id)}>
                        <button type="submit" className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint">
                          Start Draft
                        </button>
                      </form>
                    )}
                    {d.status !== "SETUP" && (
                      <Link href={`/leagues/${leagueId}/draft`} className="shrink-0 text-xs underline">
                        Open room
                      </Link>
                    )}
                  </div>
                  {d.status === "SETUP" && (
                    <DraftSetupEditForm
                      leagueId={leagueId}
                      draftId={d.id}
                      teams={league.teams.map((t) => ({ id: t.id, name: t.name }))}
                      currentRoundCount={(pickCountByDraftId.get(d.id) ?? league.teams.length) / Math.max(1, league.teams.length)}
                      currentPickTimerSeconds={d.pickTimerSeconds}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <DraftSetupForm leagueId={leagueId} teams={league.teams.map((t) => ({ id: t.id, name: t.name }))} defaultSeason={currentSeason} />
          <div className="mt-4 border-t border-border pt-3">
            <ConfirmActionButton
              action={resetDraftPickOwnershipAction.bind(null, leagueId)}
              confirmText="Revert every traded, still-unused draft pick in this league back to its original owner? Already-drafted picks are untouched."
              label="Reset draft pick ownership"
              className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-tint"
            />
          </div>
        </Card>
      </div>

      <div className="mt-10">
        <SectionLabel>Schedule</SectionLabel>
        <Card>
          {hasSchedule ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {currentSeason}-{(currentSeason + 1) % 100} schedule generated —
                see Scoreboard / Standings.
              </p>
              <ResetScheduleButton leagueId={leagueId} season={currentSeason} />
            </div>
          ) : (
            <form action={generateScheduleAction.bind(null, leagueId)} className="space-y-2">
              <p className="text-xs text-muted">
                Generate a round-robin schedule for the {currentSeason}-
                {(currentSeason + 1) % 100} season. One-time — can&apos;t be
                regenerated once created.
              </p>
              <input type="hidden" name="season" value={currentSeason} />
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
                Regular season weeks
                <input
                  type="number"
                  name="weekCount"
                  defaultValue={21}
                  min={1}
                  required
                  className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs text-muted">
                Playoff bracket (right after the regular season — round count follows from bracket size)
                <select
                  name="playoffTeams"
                  defaultValue={0}
                  className="mt-1 block w-full rounded border border-border bg-white px-2 py-1 text-sm text-black"
                >
                  <option value={0}>None</option>
                  <option value={2}>2 teams (1 round — Championship)</option>
                  <option value={4}>4 teams (2 rounds — Semifinal, Championship)</option>
                  <option value={8}>8 teams (3 rounds — Quarterfinal, Semifinal, Championship)</option>
                </select>
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

      <div className="mt-10">
        <SectionLabel>Teams &amp; managers</SectionLabel>
        <p className="mb-3 text-xs text-muted">
          Rename any team, group teams into divisions (display/standings only — schedule and
          playoff seeding are unaffected), reassign or orphan a manager, add a placeholder team
          and hand it off via claim link, {isPrimaryCommissioner ? "grant co-commissioner powers, " : ""}
          or delete a team that has no real history yet.
        </p>
        <TeamManagementCard leagueId={leagueId} teams={teamsWithHistory} origin={origin} isPrimaryCommissioner={isPrimaryCommissioner} />
      </div>

      {settings.leagueType === "REDRAFT" && (
        <div className="mt-10">
          <SectionLabel>Season</SectionLabel>
          <Card className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">Current season: {currentSeason}</p>
              <p className="mt-1 text-xs text-muted">
                Empties every roster on this league back to free agency and advances to{" "}
                {currentSeason + 1} — set up a new startup draft afterward from the Draft card
                above. Any trade still pending is cancelled first.
              </p>
            </div>
            <StartNewSeasonButton leagueId={leagueId} currentSeason={currentSeason} />
          </Card>
        </div>
      )}

      <div className="mt-10">
        <SectionLabel>Invite link</SectionLabel>
        <Card>
          <p className="text-xs text-muted">
            The site itself is open to anyone signed in — this link is what actually lets someone
            join <em>this</em> league. Share it with whoever you want in; regenerating it
            invalidates the old link.
          </p>
          {inviteUrl ? (
            <p className="mt-2 select-all rounded border border-border bg-surface-tint px-3 py-2 text-sm">
              {inviteUrl}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">No invite link generated yet.</p>
          )}
          <form action={regenerateInviteCodeAction.bind(null, leagueId)} className="mt-3">
            <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
              {inviteUrl ? "Regenerate link" : "Generate invite link"}
            </button>
          </form>
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
