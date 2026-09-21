"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addScoreAdjustmentAction, removeScoreAdjustmentAction } from "./actions";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import type { ScoreAdjustmentSummary } from "@/lib/matchups/standings";

interface Side {
  teamId: string;
  name: string;
  adjustments: ScoreAdjustmentSummary[];
}

const inputClass = "mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground";

/** Commissioner-only "Adjust Scoring" link + modal on a Scoreboard matchup
 * card (LM Tools Task 10). Owns its own open state, same shape as
 * NotificationsButton — a server-rendered MatchupCard just drops this in as
 * a child. Calls the Server Actions directly (not a raw <form>) so a
 * refusal or success can be shown inline without leaving the modal, same
 * pattern as RosterMoveActionButton. */
export function AdjustScoringModal({ leagueId, matchupPeriodId, home, away }: { leagueId: string; matchupPeriodId: string; home: Side; away: Side }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"home" | "away">("home");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = Number(points);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Enter a nonzero number of points.");
      return;
    }
    setPending(true);
    setError(null);
    const teamId = side === "home" ? home.teamId : away.teamId;
    const result = await addScoreAdjustmentAction(leagueId, matchupPeriodId, teamId, parsed, reason);
    setPending(false);
    if (result.ok) {
      setPoints("");
      setReason("");
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  async function handleRemove(id: string) {
    setPending(true);
    setError(null);
    const result = await removeScoreAdjustmentAction(leagueId, id);
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-blue hover:underline underline-offset-2">
        Adjust Scoring
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Adjust Scoring">
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <span className="text-xs text-muted">Team</span>
            <div className="flex flex-col gap-1.5">
              {([
                { key: "home" as const, s: home },
                { key: "away" as const, s: away },
              ]).map(({ key, s }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="adjustSide" checked={side === key} onChange={() => setSide(key)} />
                  {s.name}
                </label>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-xs text-muted">Points (+/-)</span>
            <input
              type="number"
              step="0.1"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              placeholder="e.g. 5.5 or -3"
              className={inputClass}
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">Reason (optional)</span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="button" variant="primary" size="sm" disabled={pending} onClick={handleSave}>
            Save
          </Button>

          {(home.adjustments.length > 0 || away.adjustments.length > 0) && (
            <div className="border-t border-border pt-3">
              <span className="text-xs text-muted">Existing adjustments</span>
              <ul className="mt-1.5 space-y-1.5">
                {[
                  ...home.adjustments.map((a) => ({ ...a, teamName: home.name })),
                  ...away.adjustments.map((a) => ({ ...a, teamName: away.name })),
                ].map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {a.teamName}: {a.points > 0 ? "+" : ""}
                      {a.points.toFixed(1)}
                      {a.reason ? ` — ${a.reason}` : ""}
                    </span>
                    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => handleRemove(a.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
