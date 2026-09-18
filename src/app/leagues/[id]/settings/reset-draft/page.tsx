import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getResettableDraftsPreview } from "@/lib/draft/reset";
import { Badge } from "@/components/Button";
import { Card } from "@/components/Card";
import { ResetDraftConfirmForm } from "./ResetDraftConfirmForm";

export default async function ResetDraftPage(props: PageProps<"/leagues/[id]/settings/reset-draft">) {
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const previews = await getResettableDraftsPreview(leagueId);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Reset Draft</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        Roll back a draft and start over. The draft returns to Setup — pick ownership (including any
        traded picks) is kept, only who each pick was used on is cleared.
      </p>

      <div className="mt-8 space-y-6">
        {previews.length === 0 && (
          <Card>
            <p className="text-sm text-muted">No draft in this league is currently resettable — only a draft that&apos;s in progress or complete can be reset.</p>
          </Card>
        )}

        {previews.map((p) => (
          <Card key={p.draftId}>
            <div className="flex items-center gap-2">
              <h2 className="font-heading text-sm font-semibold">
                {p.season} {p.type === "STARTUP" ? "Startup" : "Rookie"} draft
              </h2>
              <Badge tone="muted">{p.status.replace("_", " ")}</Badge>
            </div>

            <p className="mt-2 text-sm text-muted">
              {p.type === "STARTUP" ? (
                <>
                  This is a <strong>startup</strong> draft — resetting it empties every roster in the league.
                </>
              ) : (
                <>
                  This is a <strong>rookie</strong> draft — resetting it only removes the players it drafted,
                  wherever they are now. Every other rostered player is untouched.
                </>
              )}
            </p>

            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>{p.teamCount} team{p.teamCount === 1 ? "" : "s"} in this league</li>
              <li>
                {p.openSlotsToClose} open roster slot{p.openSlotsToClose === 1 ? "" : "s"} will be closed
              </li>
              <li>
                {p.picksToUnuse} draft pick{p.picksToUnuse === 1 ? "" : "s"} will be un-used (pick ownership is kept)
              </li>
              <li>Any pending trades, waiver claims, or FAAB bids in the league will be cancelled or voided</li>
              <li>Lineup entries from today forward for the affected players will be cleared</li>
            </ul>

            <div className="mt-4 border-t border-border pt-3">
              <ResetDraftConfirmForm leagueId={leagueId} draftId={p.draftId} leagueName={league.name} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
