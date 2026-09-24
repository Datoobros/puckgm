import { getTeamRosterView } from "@/lib/rosters/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { PlayerName } from "@/components/player-profile/PlayerName";
import { RosterMoveActionButton } from "./RosterMoveActionButton";
import type { PerformAs } from "./actions";

export async function DropPlayerStep({ leagueId, teamId, performAs }: { leagueId: string; teamId: string; performAs: PerformAs }) {
  const slots = await getTeamRosterView(teamId);
  const groups = [
    { label: "Active", rows: slots.filter((s) => s.slotType === "ACTIVE") },
    { label: "Farm", rows: slots.filter((s) => s.slotType === "FARM") },
    { label: "IR", rows: slots.filter((s) => s.slotType === "IR") },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      {groups.map((g) => (
        <div key={g.label}>
          <SectionLabel>{g.label}</SectionLabel>
          {g.rows.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">No players.</p>
            </Card>
          ) : (
            <Card className="!p-0 overflow-hidden">
              <ul className="divide-y divide-border">
                {g.rows.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <PlayerHeadshot url={s.player.headshotUrl} alt={s.player.fullName} size={28} />
                      <PlayerName playerId={s.playerId} fullName={s.player.fullName} />
                      <span className="text-xs text-muted">
                        {s.player.primaryPosition ?? "—"} · {s.player.currentNhlOrg ?? "—"}
                      </span>
                    </span>
                    <RosterMoveActionButton
                      kind="drop"
                      leagueId={leagueId}
                      teamId={teamId}
                      playerId={s.playerId}
                      performAs={performAs}
                      label="Drop"
                      variant="danger"
                      confirmText={`Drop ${s.player.fullName}?`}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ))}
    </div>
  );
}
