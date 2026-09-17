"use client";

import { useState } from "react";
import { setWaiverPriorityAction } from "@/app/leagues/[id]/waivers/actions";
import { Button } from "@/components/Button";

interface TeamOption {
  id: string;
  name: string;
}

export function WaiverOrderEditor({ leagueId, teams }: { leagueId: string; teams: TeamOption[] }) {
  const [order, setOrder] = useState(teams.map((t) => t.id));
  const nameById = new Map(teams.map((t) => [t.id, t.name]));

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  return (
    <form action={setWaiverPriorityAction.bind(null, leagueId)}>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {order.map((teamId, i) => (
          <li key={teamId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <span>
              <span className="mr-2 text-xs text-muted">{i + 1}.</span>
              {nameById.get(teamId) ?? teamId}
            </span>
            <span className="flex gap-1">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="rounded border border-border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === order.length - 1}
                className="rounded border border-border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Move down"
              >
                ▼
              </button>
            </span>
            <input type="hidden" name="order" value={teamId} />
          </li>
        ))}
      </ol>
      <Button type="submit" variant="primary" size="sm" className="mt-4">
        Save
      </Button>
    </form>
  );
}
