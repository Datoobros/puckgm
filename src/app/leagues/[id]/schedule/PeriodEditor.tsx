"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updatePeriodMatchupsAction } from "./actions";
import { Button } from "@/components/Button";

interface TeamOption {
  id: string;
  name: string;
}

interface Pair {
  homeTeamId: string;
  awayTeamId: string;
}

const selectClass = "rounded border border-border bg-surface px-2 py-1 text-sm text-foreground";

/** Commissioner-only editor for one MatchupPeriod's pairings, rendered
 * inline in place of that period's table when `?edit=<periodId>` is set
 * (LM Tools Task 11). A team left out of every row below has a bye that
 * week, same as an odd team count already produces at schedule generation. */
export function PeriodEditor({
  leagueId,
  season,
  periodId,
  teams,
  initialPairs,
}: {
  leagueId: string;
  season: number;
  periodId: string;
  teams: TeamOption[];
  initialPairs: Pair[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Pair[]>(
    initialPairs.length > 0 ? initialPairs : [{ homeTeamId: "", awayTeamId: "" }],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameById = new Map(teams.map((t) => [t.id, t.name]));
  const selectedIds = rows.flatMap((r) => [r.homeTeamId, r.awayTeamId]).filter(Boolean);
  const duplicateIds = [...new Set(selectedIds.filter((id, i) => selectedIds.indexOf(id) !== i))];
  const duplicateNames = duplicateIds.map((id) => nameById.get(id) ?? id);
  const hasSelfMatch = rows.some((r) => r.homeTeamId && r.homeTeamId === r.awayTeamId);
  const hasIncompleteRow = rows.some((r) => !r.homeTeamId || !r.awayTeamId);
  const canSave = !hasSelfMatch && duplicateNames.length === 0 && !hasIncompleteRow;

  function cancelHref() {
    const params = new URLSearchParams({ season: String(season) });
    return `/leagues/${leagueId}/schedule?${params.toString()}`;
  }

  function updateRow(index: number, field: keyof Pair, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  async function handleSave() {
    setPending(true);
    setError(null);
    const result = await updatePeriodMatchupsAction(leagueId, periodId, rows);
    setPending(false);
    if (result.ok) {
      router.push(cancelHref());
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-muted">Away</span>
            <select value={row.awayTeamId} onChange={(e) => updateRow(i, "awayTeamId", e.target.value)} className={selectClass}>
              <option value="">Select team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">at</span>
            <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-muted">Home</span>
            <select value={row.homeTeamId} onChange={(e) => updateRow(i, "homeTeamId", e.target.value)} className={selectClass}>
              <option value="">Select team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
              Remove matchup
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setRows((prev) => [...prev, { homeTeamId: "", awayTeamId: "" }])}
        >
          Add matchup
        </Button>
      </div>

      {hasSelfMatch && <p className="mt-2 text-sm text-danger">A team can&apos;t be matched up against itself.</p>}
      {duplicateNames.length > 0 && (
        <p className="mt-2 text-sm text-danger">
          {duplicateNames.join(", ")} appear{duplicateNames.length === 1 ? "s" : ""} in more than one matchup.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <p className="mt-2 text-xs text-muted">A team left out of every matchup above has a bye this week.</p>

      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="primary" size="sm" disabled={pending || !canSave} onClick={handleSave}>
          Save
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => router.push(cancelHref())}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
