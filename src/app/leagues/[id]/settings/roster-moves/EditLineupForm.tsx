"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { lmEditLineupAction } from "./actions";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { PlayerName } from "@/components/player-profile/PlayerName";

export interface LineupRow {
  playerId: string;
  fullName: string;
  headshotUrl: string | null;
  position: string;
  opponentLabel: string;
  locked: boolean;
  currentSlot: string;
  eligibleSlots: string[]; // includes "BE"
}

const selectClass = "rounded border border-border bg-surface px-2 py-1 text-sm text-foreground";

/** Edit Lineup step 2's table + Save — one `<select>` per Active-roster
 * player, using whatever slots eligibleSlotsForPosition already computed
 * server-side (plus "BE", always available). A locked player's select is
 * disabled with a lock marker instead of being hidden, so the commissioner
 * can see exactly who's unavailable and why. */
export function EditLineupForm({
  leagueId,
  teamId,
  date,
  rows,
}: {
  leagueId: string;
  teamId: string;
  date: string;
  rows: LineupRow[];
}) {
  const router = useRouter();
  const [slots, setSlots] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.playerId, r.currentSlot])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const changedCount = rows.filter((r) => !r.locked && slots[r.playerId] !== r.currentSlot).length;

  async function handleSave() {
    const changes = rows
      .filter((r) => !r.locked && slots[r.playerId] !== r.currentSlot)
      .map((r) => ({ playerId: r.playerId, slot: slots[r.playerId] }));
    if (changes.length === 0) return;

    setPending(true);
    setError(null);
    setSaved(false);
    const result = await lmEditLineupAction(leagueId, teamId, date, changes);
    setPending(false);
    if (result.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <div>
      <Card className="overflow-x-auto !p-0">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2 font-medium">Player</th>
              <th className="px-4 py-2 font-medium">Pos</th>
              <th className="px-4 py-2 font-medium">Today&apos;s game</th>
              <th className="px-4 py-2 font-medium">Slot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.playerId} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={r.headshotUrl} alt={r.fullName} size={28} />
                    <PlayerName playerId={r.playerId} fullName={r.fullName} />
                  </span>
                </td>
                <td className="px-4 py-2 text-muted">{r.position}</td>
                <td className="px-4 py-2 text-muted">{r.opponentLabel}</td>
                <td className="px-4 py-2">
                  {r.locked ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted" title="Game already started — locked">
                      🔒 {r.currentSlot}
                    </span>
                  ) : (
                    <select
                      value={slots[r.playerId]}
                      onChange={(e) => setSlots((prev) => ({ ...prev, [r.playerId]: e.target.value }))}
                      className={selectClass}
                    >
                      {r.eligibleSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {slot}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {saved && !error && <p className="mt-2 text-sm text-success">Lineup saved.</p>}

      <div className="mt-3">
        <Button type="button" variant="primary" size="sm" disabled={pending || changedCount === 0} onClick={handleSave}>
          Save{changedCount > 0 ? ` (${changedCount} change${changedCount === 1 ? "" : "s"})` : ""}
        </Button>
      </div>
    </div>
  );
}
