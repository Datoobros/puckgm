"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { addPlayerAction } from "./actions";

/** Adding a free agent when the active roster is already at cap used to
 * throw an unhandled "Active roster is full" error straight out of the
 * Server Action. Now: clicking Add while full expands an inline picker for
 * which current active player to drop, and addPlayerAction does the drop +
 * add as one atomic transaction (src/lib/rosters/mutations.ts).
 *
 * `size="cell"` (default) is the Players table's compact markup. `size="pill"`
 * is the player-profile modal's action-card rendering — a full-width primary
 * button and a full-width picker, same underlying logic. */
export function AddPlayerCell({
  leagueId,
  teamId,
  playerId,
  activeCount,
  activeCap,
  activeRosterPlayers,
  onDone,
  size = "cell",
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  activeCount: number;
  activeCap: number;
  activeRosterPlayers: { id: string; fullName: string }[];
  onDone?: () => void | Promise<void>;
  size?: "cell" | "pill";
}) {
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [dropChoice, setDropChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isFull = activeCount >= activeCap;

  async function handleAddClick() {
    if (isFull) {
      setError(null);
      setPicking(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await addPlayerAction(leagueId, teamId, playerId);
      await onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add player.");
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDrop() {
    if (!dropChoice) return;
    setPending(true);
    setError(null);
    try {
      await addPlayerAction(leagueId, teamId, playerId, dropChoice);
      setPicking(false);
      setDropChoice("");
      await onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't drop & add.");
    } finally {
      setPending(false);
    }
  }

  if (picking) {
    if (size === "pill") {
      return (
        <div className="flex w-full flex-col gap-1.5">
          <span className="text-xs text-muted">Roster full — drop who?</span>
          <select
            value={dropChoice}
            onChange={(e) => setDropChoice(e.target.value)}
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Choose player…</option>
            {activeRosterPlayers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              className="flex-1"
              disabled={!dropChoice || pending}
              onClick={handleConfirmDrop}
            >
              Drop &amp; Add
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPicking(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[10px] text-muted">Roster full — drop who?</span>
        <div className="flex items-center gap-1">
          <select
            value={dropChoice}
            onChange={(e) => setDropChoice(e.target.value)}
            className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-foreground"
          >
            <option value="">Choose player…</option>
            {activeRosterPlayers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleConfirmDrop}
            disabled={!dropChoice || pending}
            className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-medium text-gold-foreground hover:opacity-90 disabled:opacity-50"
          >
            Drop &amp; Add
          </button>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setError(null);
            }}
            className="text-[10px] text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
        {error && <span className="text-[10px] text-danger">{error}</span>}
      </div>
    );
  }

  if (size === "pill") {
    return (
      <div className="flex w-full flex-col gap-1">
        <Button type="button" variant="primary" className="w-full" disabled={pending} onClick={handleAddClick}>
          ADD
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handleAddClick}
        disabled={pending}
        title="Add to your roster"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-gold text-sm font-bold leading-none text-gold-foreground hover:opacity-90 disabled:opacity-50"
      >
        +
      </button>
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  );
}
