"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, LinkButton } from "@/components/Button";

type Action = "ADD" | "DROP" | "IR" | "FARM" | "TRADE" | "LINEUP";

export interface RosterMovesTeamOption {
  id: string;
  name: string;
  orphaned: boolean;
}

const selectClass = "mt-0 block w-full max-w-xs rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
      <span className="w-28 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ESPN's "Choose Transaction" step 1 — a two-column definition-list form
// (label left, control right) that pushes ?action=&team=&as= on Continue
// rather than updating the URL as each field changes, so browser Back from
// step 2 lands here fresh (plans/lm-tools-batch.md Task 3).
export function RosterMovesFlow({ leagueId, teams, hasFarm }: { leagueId: string; teams: RosterMovesTeamOption[]; hasFarm: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState<Action>("ADD");
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [performAs, setPerformAs] = useState<"LM" | "TM">("LM");

  function handleContinue() {
    if (!teamId) return;
    router.push(`/leagues/${leagueId}/settings/roster-moves?action=${action}&team=${teamId}&as=${performAs}`);
  }

  return (
    <div className="max-w-2xl">
      <div className="divide-y divide-border rounded-lg border border-border">
        <Row label="Action">
          <select value={action} onChange={(e) => setAction(e.target.value as Action)} className={selectClass}>
            <option value="ADD">Add Player</option>
            <option value="DROP">Drop Player</option>
            <option value="IR">Manage IR</option>
            {hasFarm && <option value="FARM">Manage Farm Team</option>}
            <option value="TRADE">Make Trade</option>
            <option value="LINEUP" disabled>
              Edit Lineup (Task 12)
            </option>
          </select>
        </Row>

        <Row label="Team">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={selectClass}>
            {teams.map((t) => (
              <option key={t.id} value={t.id} disabled={t.orphaned}>
                {t.name}
                {t.orphaned ? " — reassign first" : ""}
              </option>
            ))}
          </select>
        </Row>

        {action === "TRADE" ? (
          <Row label="Perform as">
            <p className="text-xs text-muted">
              Not applicable — a Make Trade always executes immediately as the League Manager,
              with no acceptance or review window.
            </p>
          </Row>
        ) : (
          <Row label="Perform as">
            <div className="space-y-2">
              <label
                className="flex items-center gap-2 text-sm"
                title="Bypasses roster caps, waivers, FAAB, and the free-agency gate. Logged as a commissioner override."
              >
                <input type="radio" name="performAs" checked={performAs === "LM"} onChange={() => setPerformAs("LM")} />
                League Manager
              </label>
              <label
                className="flex items-center gap-2 text-sm"
                title="Runs exactly as if that team's manager did it — all normal rules apply."
              >
                <input type="radio" name="performAs" checked={performAs === "TM"} onChange={() => setPerformAs("TM")} />
                Team Manager
              </label>
            </div>
          </Row>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="button" variant="primary" onClick={handleContinue} disabled={!teamId}>
          Continue
        </Button>
        <LinkButton href={`/leagues/${leagueId}/settings`} variant="secondary">
          Cancel
        </LinkButton>
      </div>
    </div>
  );
}
