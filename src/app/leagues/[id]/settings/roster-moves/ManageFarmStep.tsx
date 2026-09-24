import { getTeamRosterView } from "@/lib/rosters/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { PlayerName } from "@/components/player-profile/PlayerName";
import { RosterMoveActionButton } from "./RosterMoveActionButton";
import type { PerformAs } from "./actions";

export async function ManageFarmStep({ leagueId, teamId, performAs }: { leagueId: string; teamId: string; performAs: PerformAs }) {
  const slots = await getTeamRosterView(teamId);
  const activeSlots = slots.filter((s) => s.slotType === "ACTIVE");
  const farmSlots = slots.filter((s) => s.slotType === "FARM");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <SectionLabel>Active — send to farm</SectionLabel>
        {activeSlots.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No players.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {activeSlots.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                    <PlayerName playerId={s.playerId} fullName={s.player.fullName} />
                    <span className="text-xs text-muted">
                      {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                    </span>
                  </span>
                  <RosterMoveActionButton
                    kind="move"
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={s.playerId}
                    performAs={performAs}
                    targetSlotType="FARM"
                    label="Send to Farm"
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <SectionLabel>Farm — call up</SectionLabel>
        {farmSlots.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No players on the farm.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {farmSlots.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                    <PlayerName playerId={s.playerId} fullName={s.player.fullName} />
                    <span className="text-xs text-muted">
                      {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                    </span>
                  </span>
                  <RosterMoveActionButton
                    kind="move"
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={s.playerId}
                    performAs={performAs}
                    targetSlotType="ACTIVE"
                    label="Call up"
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
