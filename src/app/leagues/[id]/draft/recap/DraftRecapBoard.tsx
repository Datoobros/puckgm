"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Button";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { PlayerName } from "@/components/player-profile/PlayerName";
import type { DraftRecapPick } from "@/lib/draft/mutations";

type ViewMode = "round" | "team";

export function DraftRecapBoard({ picks }: { picks: DraftRecapPick[] }) {
  const [view, setView] = useState<ViewMode>("round");

  const byRound = useMemo(() => {
    const map = new Map<number, DraftRecapPick[]>();
    for (const p of picks) {
      const list = map.get(p.round) ?? [];
      list.push(p);
      map.set(p.round, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [picks]);

  const byTeam = useMemo(() => {
    const map = new Map<string, { teamId: string; teamName: string; picks: DraftRecapPick[] }>();
    for (const p of picks) {
      const entry = map.get(p.teamId) ?? { teamId: p.teamId, teamName: p.teamName, picks: [] };
      entry.picks.push(p);
      map.set(p.teamId, entry);
    }
    return [...map.values()];
  }, [picks]);

  if (picks.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">No picks have been made in this draft yet.</p>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-5 border-b border-border">
        {(["round", "team"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors ${
              view === v ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {v === "round" ? "By round" : "By team"}
          </button>
        ))}
      </div>

      {view === "round" ? (
        <div className="space-y-6">
          {byRound.map(([round, roundPicks]) => (
            <div key={round}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Round {round}</p>
              <Card className="!p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      <th className="py-2 pl-4 pr-2 text-xs font-medium">Pick</th>
                      <th className="py-2 pr-2 text-xs font-medium">Team</th>
                      <th className="py-2 pr-2 text-xs font-medium">Player</th>
                      <th className="py-2 pr-2 text-xs font-medium">Pos</th>
                      <th className="py-2 pr-4 text-xs font-medium">NHL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roundPicks.map((p) => (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="py-2 pl-4 pr-2 tabular-nums text-muted">
                          {p.pickInRound} <span className="text-xs">(#{p.overallPick})</span>
                        </td>
                        <td className="py-2 pr-2">
                          {p.teamName}
                          {p.wasTraded && (
                            <span className="ml-1 text-xs text-muted">(from {p.originalTeamName})</span>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <span className="flex items-center gap-2">
                            <PlayerHeadshot url={p.playerHeadshotUrl} alt={p.playerName} size={24} />
                            <PlayerName playerId={p.playerId} fullName={p.playerName} />
                            {p.autopicked && <Badge tone="muted">Auto</Badge>}
                          </span>
                        </td>
                        <td className="py-2 pr-2 text-muted">{p.playerPosition ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted">{p.playerNhlOrg ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {byTeam.map((entry) => (
            <Card key={entry.teamId} className="!p-0 overflow-hidden">
              <p className="border-b border-border px-4 py-2 text-sm font-semibold">{entry.teamName}</p>
              <ul className="divide-y divide-border">
                {entry.picks.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <PlayerHeadshot url={p.playerHeadshotUrl} alt={p.playerName} size={20} />
                      <PlayerName playerId={p.playerId} fullName={p.playerName} className="truncate" />
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      R{p.round}·#{p.overallPick}
                      {p.autopicked && <Badge tone="muted">Auto</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
