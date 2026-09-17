import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getTradeableAssets, type TradeAssetSelection } from "@/lib/trades/mutations";
import { getPlayerStatsAggregate, type PlayerStatsRow } from "@/lib/players/rankings";
import { commissionerExecuteTradeAction } from "@/app/leagues/[id]/trades/actions";
import { TradeBuilder } from "@/app/leagues/[id]/trades/TradeBuilder";
import { TradeWithSelect } from "./TradeWithSelect";

const EMPTY_SELECTION: TradeAssetSelection = { playerIds: [], pickIds: [], faabAmount: 0 };

/** LM Roster Moves' Make Trade step 2 — executes immediately (no propose/
 * accept/review), always League Manager mode regardless of the step-1
 * Perform-as choice (ignored for trades). A "Trade with" pick has to happen
 * here, before the builder can load either side's tradeable assets. */
export async function MakeTradeStep({
  leagueId,
  teamId,
  withTeamId,
}: {
  leagueId: string;
  teamId: string;
  withTeamId: string | null;
}) {
  const league = await getLeague(leagueId);
  if (!league) return null;
  const settings = league.settingsJson as unknown as LeagueSettings;

  const fromTeam = league.teams.find((t) => t.id === teamId);
  if (!fromTeam) return null;

  const otherTeams = league.teams.filter((t) => t.id !== teamId && t.state !== "ORPHAN_FROZEN");
  const toTeam = withTeamId ? otherTeams.find((t) => t.id === withTeamId) : undefined;

  if (!toTeam) {
    return (
      <div className="max-w-xs">
        <p className="mb-2 text-sm text-muted">Trade {fromTeam.name} with:</p>
        <TradeWithSelect
          leagueId={leagueId}
          teamId={teamId}
          otherTeams={otherTeams.map((t) => ({ id: t.id, name: t.name }))}
          currentWithId={withTeamId ?? undefined}
        />
      </div>
    );
  }

  const [fromAssets, toAssets] = await Promise.all([getTradeableAssets(teamId), getTradeableAssets(toTeam.id)]);
  const allPlayerIds = [...fromAssets.players.map((p) => p.id), ...toAssets.players.map((p) => p.id)];
  const statsRows =
    allPlayerIds.length > 0
      ? await getPlayerStatsAggregate({ playerIds: allPlayerIds, scoringConfig: settings.scoringConfig })
      : [];
  const statsById: Record<string, PlayerStatsRow> = Object.fromEntries(statsRows.map((r) => [r.id, r]));

  return (
    <div>
      <p className="mb-3 text-sm text-muted">
        Trading {fromTeam.name} with {toTeam.name} — executes immediately, no acceptance or review window.{" "}
        <span className="ml-2 inline-block align-middle">
          <TradeWithSelect
            leagueId={leagueId}
            teamId={teamId}
            otherTeams={otherTeams.map((t) => ({ id: t.id, name: t.name }))}
            currentWithId={toTeam.id}
          />
        </span>
      </p>
      <TradeBuilder
        leagueId={leagueId}
        myTeamId={teamId}
        myTeamName={fromTeam.name}
        myAssets={fromAssets}
        otherTeams={otherTeams.map((t) => ({ teamId: t.id, teamName: t.name }))}
        counterpartyId={toTeam.id}
        counterpartyName={toTeam.name}
        counterpartyAssets={toAssets}
        statsById={statsById}
        initialGive={EMPTY_SELECTION}
        initialReceive={EMPTY_SELECTION}
        mode="commissioner"
        submitAction={commissionerExecuteTradeAction}
      />
    </div>
  );
}
