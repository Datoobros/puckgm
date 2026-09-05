import {
  renameTeamAction,
  addTeamAsCommissionerAction,
  reassignTeamManagerAction,
  orphanTeamAction,
  regenerateTeamClaimCodeAction,
  setTeamDivisionAction,
  setCoCommissionerAction,
} from "@/app/leagues/actions";
import { Card } from "@/components/Card";
import { DeleteTeamButton } from "@/components/DeleteTeamButton";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";

interface TeamRow {
  id: string;
  name: string;
  managerUserId: string;
  state: string;
  isCoCommissioner: boolean;
  division: string | null;
  claimCode: string | null;
  hasHistory: boolean;
}

const inputClass = "rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-blue";

export function TeamManagementCard({
  leagueId,
  teams,
  origin,
  isPrimaryCommissioner,
}: {
  leagueId: string;
  teams: TeamRow[];
  origin: string;
  isPrimaryCommissioner: boolean;
}) {
  return (
    <Card className="space-y-5">
      {teams.map((team) => (
        <div key={team.id} className="space-y-2 border-b border-border pb-4 last:border-0 last:pb-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{team.name}</span>
            {team.state === "ORPHAN_FROZEN" && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                ORPHANED — frozen
              </span>
            )}
            {team.isCoCommissioner && (
              <span className="rounded bg-gold/10 px-1.5 py-0.5 text-[10px] font-medium text-gold">Co-commissioner</span>
            )}
          </div>
          <p className="text-xs text-muted">manager: {team.managerUserId}</p>

          <div className="flex flex-wrap items-center gap-2">
            <form action={renameTeamAction.bind(null, leagueId, team.id)} className="flex items-center gap-1">
              <input name="name" defaultValue={team.name} className={inputClass} placeholder="Team name" />
              <button type="submit" className="rounded-full border border-border px-2 py-1 text-xs hover:bg-surface-tint">
                Rename
              </button>
            </form>

            <form action={setTeamDivisionAction.bind(null, leagueId, team.id)} className="flex items-center gap-1">
              <input name="division" defaultValue={team.division ?? ""} placeholder="Division (blank = none)" className={inputClass} />
              <button type="submit" className="rounded-full border border-border px-2 py-1 text-xs hover:bg-surface-tint">
                Set division
              </button>
            </form>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <form action={reassignTeamManagerAction.bind(null, leagueId, team.id)} className="flex items-center gap-1">
              <input name="newManagerUserId" placeholder="New manager's user ID" className={inputClass} />
              <button type="submit" className="rounded-full border border-border px-2 py-1 text-xs hover:bg-surface-tint">
                Reassign
              </button>
            </form>

            {team.state !== "ORPHAN_FROZEN" && (
              <ConfirmActionButton
                action={orphanTeamAction.bind(null, leagueId, team.id)}
                confirmText={`Mark "${team.name}" as orphaned? Its roster freezes (no trades, adds/drops, waivers, or FAAB) until reassigned.`}
                label="Orphan"
                className="rounded-full border border-border px-2 py-1 text-xs hover:bg-surface-tint"
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {team.claimCode ? (
              <p className="select-all rounded border border-border bg-surface-tint px-2 py-1 text-xs">
                {origin}/invite/team/{team.claimCode}
              </p>
            ) : (
              <p className="text-xs text-muted">No claim link generated.</p>
            )}
            <form action={regenerateTeamClaimCodeAction.bind(null, leagueId, team.id)}>
              <button type="submit" className="rounded-full border border-border px-2 py-1 text-xs hover:bg-surface-tint">
                {team.claimCode ? "Regenerate claim link" : "Generate claim link"}
              </button>
            </form>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isPrimaryCommissioner && (
              <form action={setCoCommissionerAction.bind(null, leagueId, team.id)} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  name="isCoCommissioner"
                  defaultChecked={team.isCoCommissioner}
                  id={`cocomm-${team.id}`}
                  className="h-3.5 w-3.5"
                />
                <label htmlFor={`cocomm-${team.id}`}>Co-commissioner</label>
                <button type="submit" className="rounded-full border border-border px-2 py-0.5 hover:bg-surface-tint">
                  Save
                </button>
              </form>
            )}
            {team.hasHistory ? (
              <span className="text-xs text-muted" title="Has roster, draft pick, trade, waiver, FAAB, or schedule history">
                Can&apos;t delete — has real history
              </span>
            ) : (
              <DeleteTeamButton leagueId={leagueId} teamId={team.id} teamName={team.name} />
            )}
          </div>
        </div>
      ))}

      <form action={addTeamAsCommissionerAction.bind(null, leagueId)} className="flex items-center gap-2 pt-1">
        <input name="teamName" required placeholder="New team name" className={inputClass} />
        <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-tint">
          Add Team
        </button>
      </form>
      <p className="text-xs text-muted">
        A commissioner-added team starts owned by you administratively — generate its claim link and hand it to the real manager.
      </p>
    </Card>
  );
}
