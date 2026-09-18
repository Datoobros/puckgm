import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isTeamManager } from "@/lib/leagues/mutations";
import { getDraftRecap } from "@/lib/draft/mutations";
import { prisma } from "@/lib/db";
import { Card } from "@/components/Card";
import { DraftRecapBoard } from "./DraftRecapBoard";
import { DraftRecapSelect } from "./DraftRecapSelect";

export default async function DraftRecapPage(props: PageProps<"/leagues/[id]/draft/recap">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawDraft = Array.isArray(sp.draft) ? sp.draft[0] : sp.draft;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const myTeam = league.teams.find((t) => isTeamManager(t, userId)) ?? null;

  if (!myTeam) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Draft Recap</h1>
        <Card className="mt-6">
          <p className="text-sm text-muted">
            You&apos;re not a member of this league. Ask the commissioner for an invite link to join.
          </p>
        </Card>
      </div>
    );
  }

  const drafts = await prisma.draft.findMany({ where: { leagueId }, orderBy: { createdAt: "desc" } });
  const selectableDrafts = drafts.filter((d) => d.status !== "SETUP");
  const requested = rawDraft ? drafts.find((d) => d.id === rawDraft) : undefined;
  const target = requested ?? selectableDrafts[0] ?? drafts[0] ?? null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/leagues/${leagueId}/draft`} className="text-sm text-muted hover:underline">
            ← Draft
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Draft Recap</h1>
        </div>
        {selectableDrafts.length > 1 && (
          <DraftRecapSelect
            leagueId={leagueId}
            drafts={selectableDrafts.map((d) => ({
              id: d.id,
              label: `${d.season} ${d.type === "STARTUP" ? "Startup" : "Rookie"}`,
            }))}
            selectedDraftId={target?.id ?? ""}
          />
        )}
      </div>

      {!target ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">No draft has been set up for this league yet.</p>
        </Card>
      ) : target.status === "SETUP" ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">
            The {target.season} {target.type === "STARTUP" ? "startup" : "rookie"} draft hasn&apos;t started
            yet — nothing to recap.
          </p>
        </Card>
      ) : (
        <DraftRecapContent draftId={target.id} season={target.season} type={target.type} status={target.status} />
      )}
    </div>
  );
}

async function DraftRecapContent({
  draftId,
  season,
  type,
  status,
}: {
  draftId: string;
  season: number;
  type: "STARTUP" | "ROOKIE";
  status: "SETUP" | "IN_PROGRESS" | "COMPLETE";
}) {
  const recap = await getDraftRecap(draftId);
  return (
    <div className="mt-6">
      <p className="mb-4 text-sm text-muted">
        {season} {type === "STARTUP" ? "Startup" : "Rookie"} draft —{" "}
        {status === "COMPLETE" ? "complete" : "in progress"}
      </p>
      <DraftRecapBoard picks={recap.picks} />
    </div>
  );
}
