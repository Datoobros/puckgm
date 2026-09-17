import { getTeamRosterView } from "@/lib/rosters/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { Badge } from "@/components/Button";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { RosterMoveActionButton } from "./RosterMoveActionButton";
import type { PerformAs } from "./actions";

export async function ManageIrStep({ leagueId, teamId, performAs }: { leagueId: string; teamId: string; performAs: PerformAs }) {
  const slots = await getTeamRosterView(teamId);
  const eligible = slots.filter((s) => s.slotType === "ACTIVE" || s.slotType === "FARM");
  const irSlots = slots.filter((s) => s.slotType === "IR");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <SectionLabel>Active &amp; Farm — place on IR</SectionLabel>
        {eligible.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No players.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {eligible.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                    {s.player.fullName}
                    <span className="text-xs text-muted">
                      {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"} · {s.slotType}
                    </span>
                    {s.player.officialRosterStatus && (
                      <Badge tone="danger">{s.player.officialRosterStatus}</Badge>
                    )}
                  </span>
                  <RosterMoveActionButton
                    kind="move"
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={s.playerId}
                    performAs={performAs}
                    targetSlotType="IR"
                    label="Place on IR"
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <SectionLabel>IR — activate</SectionLabel>
        {irSlots.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No players on IR.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {irSlots.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                    {s.player.fullName}
                    <span className="text-xs text-muted">
                      {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                    </span>
                    <Badge tone="muted">{s.player.officialRosterStatus ?? "IR"}</Badge>
                  </span>
                  <span className="flex items-center gap-2">
                    <RosterMoveActionButton
                      kind="move"
                      leagueId={leagueId}
                      teamId={teamId}
                      playerId={s.playerId}
                      performAs={performAs}
                      targetSlotType="ACTIVE"
                      label="Activate to Active"
                    />
                    <RosterMoveActionButton
                      kind="move"
                      leagueId={leagueId}
                      teamId={teamId}
                      playerId={s.playerId}
                      performAs={performAs}
                      targetSlotType="FARM"
                      label="Activate to Farm"
                    />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
