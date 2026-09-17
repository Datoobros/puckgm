import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { Badge } from "@/components/Button";
import { RosterMovesFlow, type RosterMovesTeamOption } from "./RosterMovesFlow";
import { AddPlayerStep } from "./AddPlayerStep";
import { DropPlayerStep } from "./DropPlayerStep";
import { ManageIrStep } from "./ManageIrStep";
import { ManageFarmStep } from "./ManageFarmStep";
import type { PerformAs } from "./actions";

const VALID_ACTIONS = new Set(["ADD", "DROP", "IR", "FARM"]);

export default async function RosterMovesPage(props: PageProps<"/leagues/[id]/settings/roster-moves">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawAction = Array.isArray(sp.action) ? sp.action[0] : sp.action;
  const rawTeam = Array.isArray(sp.team) ? sp.team[0] : sp.team;
  const rawAs = Array.isArray(sp.as) ? sp.as[0] : sp.as;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const hasFarm = settings.farmSlots > 0;

  const teamOptions: RosterMovesTeamOption[] = league.teams.map((t) => ({
    id: t.id,
    name: t.name,
    orphaned: t.state === "ORPHAN_FROZEN",
  }));

  const selectedTeam = league.teams.find((t) => t.id === rawTeam);
  const performAs: PerformAs | null = rawAs === "LM" || rawAs === "TM" ? rawAs : null;
  const isStep2 =
    !!rawAction &&
    VALID_ACTIONS.has(rawAction) &&
    !!selectedTeam &&
    selectedTeam.state !== "ORPHAN_FROZEN" &&
    performAs !== null &&
    (rawAction !== "FARM" || hasFarm);

  return (
    <div>
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Roster Moves</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Add, drop, or move players on any team&apos;s roster — as the League Manager (full
        bypass) or as that team&apos;s own manager (normal rules apply).
      </p>

      <div className="mt-8">
        {!isStep2 ? (
          <RosterMovesFlow leagueId={leagueId} teams={teamOptions} hasFarm={hasFarm} />
        ) : (
          <>
            <p className="mb-4 text-sm">
              Team: <strong>{selectedTeam!.name}</strong> · Performing as:{" "}
              <strong>{performAs === "LM" ? "League Manager" : "Team Manager"}</strong>{" "}
              <Link
                href={`/leagues/${leagueId}/settings/roster-moves`}
                className="ml-2 text-xs text-blue hover:underline"
              >
                Change
              </Link>
            </p>
            {rawAction === "ADD" && <AddPlayerStep leagueId={leagueId} teamId={selectedTeam!.id} performAs={performAs!} />}
            {rawAction === "DROP" && <DropPlayerStep leagueId={leagueId} teamId={selectedTeam!.id} performAs={performAs!} />}
            {rawAction === "IR" && <ManageIrStep leagueId={leagueId} teamId={selectedTeam!.id} performAs={performAs!} />}
            {rawAction === "FARM" && <ManageFarmStep leagueId={leagueId} teamId={selectedTeam!.id} performAs={performAs!} />}
          </>
        )}
      </div>
    </div>
  );
}
