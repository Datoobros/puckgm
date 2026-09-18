import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { startDraftAction, resetDraftPickOwnershipAction } from "@/app/leagues/[id]/draft/actions";
import { getMaxDraftRounds } from "@/lib/draft/mutations";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { Button, LinkButton, Badge } from "@/components/Button";
import { DraftSetupForm } from "../DraftSetupForm";
import { DraftSetupEditForm } from "../DraftSetupEditForm";
import { Card, SectionLabel } from "@/components/Card";
import { prisma } from "@/lib/db";

export default async function DraftSettingsPage(props: PageProps<"/leagues/[id]/settings/draft-settings">) {
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const currentSeason = league.currentSeason;

  const drafts = await prisma.draft.findMany({ where: { leagueId }, orderBy: { createdAt: "desc" } });
  const draftPickCounts = await prisma.draftPick.groupBy({
    by: ["draftId"],
    where: { draftId: { in: drafts.map((d) => d.id) } },
    _count: { _all: true },
  });
  const pickCountByDraftId = new Map(draftPickCounts.map((g) => [g.draftId, g._count._all]));
  const maxDraftRounds = await getMaxDraftRounds(leagueId);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Draft Settings</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Set up or edit an upcoming startup or rookie draft.
      </p>

      <div className="mt-8">
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
                        <Button type="submit" size="sm">Start Draft</Button>
                      </form>
                    )}
                    {d.status !== "SETUP" && (
                      <div className="flex items-center gap-3">
                        <LinkButton href={`/leagues/${leagueId}/draft`} variant="ghost">
                          Open room
                        </LinkButton>
                        <LinkButton href={`/leagues/${leagueId}/settings/reset-draft`} variant="ghost">
                          Reset draft
                        </LinkButton>
                      </div>
                    )}
                  </div>
                  {d.status === "SETUP" && (
                    <DraftSetupEditForm
                      leagueId={leagueId}
                      draftId={d.id}
                      teams={league.teams.map((t) => ({ id: t.id, name: t.name }))}
                      currentRoundCount={(pickCountByDraftId.get(d.id) ?? league.teams.length) / Math.max(1, league.teams.length)}
                      currentPickTimerSeconds={d.pickTimerSeconds}
                      maxRounds={maxDraftRounds}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <DraftSetupForm
            leagueId={leagueId}
            teams={league.teams.map((t) => ({ id: t.id, name: t.name }))}
            defaultSeason={currentSeason}
            maxRounds={maxDraftRounds}
          />
          <div className="mt-4 border-t border-border pt-3">
            <ConfirmActionButton
              action={resetDraftPickOwnershipAction.bind(null, leagueId)}
              confirmText="Revert every traded, still-unused draft pick in this league back to its original owner? Already-drafted picks are untouched."
              label="Reset draft pick ownership"
              size="sm"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
