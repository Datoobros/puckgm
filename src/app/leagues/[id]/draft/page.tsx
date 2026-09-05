import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague } from "@/lib/leagues/mutations";
import { getCurrentDraft, resolveDraftState } from "@/lib/draft/mutations";
import { Card } from "@/components/Card";
import { DraftRoom } from "./DraftRoom";

export default async function DraftPage(props: PageProps<"/leagues/[id]/draft">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const myTeam = league.teams.find((t) => t.managerUserId === userId) ?? null;

  const draft = await getCurrentDraft(leagueId);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Draft</h1>

      {!draft ? (
        <Card className="mt-4">
          <p className="text-sm text-muted">
            No draft has been set up for this league yet. A commissioner can start one from{" "}
            <Link href={`/leagues/${leagueId}/settings`} className="underline">
              Commissioner Settings
            </Link>
            .
          </p>
        </Card>
      ) : draft.status === "SETUP" ? (
        <Card className="mt-4">
          <p className="text-sm text-muted">
            A {draft.type === "STARTUP" ? "startup" : "rookie"} draft for {draft.season} is set up but
            hasn&apos;t started yet. Picks are already real, tradeable assets — trade them from{" "}
            <Link href={`/leagues/${leagueId}/trades`} className="underline">
              Trades
            </Link>{" "}
            if you like. The commissioner can start the clock from{" "}
            <Link href={`/leagues/${leagueId}/settings`} className="underline">
              Commissioner Settings
            </Link>
            .
          </p>
        </Card>
      ) : (
        <div className="mt-4">
          <p className="mb-4 text-sm text-muted">
            {draft.type === "STARTUP" ? "Startup" : "Rookie"} draft — {draft.season}
          </p>
          <DraftRoomLoader leagueId={leagueId} draftId={draft.id} myTeamId={myTeam?.id ?? null} />
        </div>
      )}
    </div>
  );
}

async function DraftRoomLoader({ leagueId, draftId, myTeamId }: { leagueId: string; draftId: string; myTeamId: string | null }) {
  const initialState = await resolveDraftState(draftId);
  return <DraftRoom leagueId={leagueId} draftId={draftId} myTeamId={myTeamId} initialState={initialState} />;
}
