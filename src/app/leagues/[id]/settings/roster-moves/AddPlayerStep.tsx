"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchPlayersAction } from "@/app/leagues/[id]/players/actions";
import { PlayerName } from "@/components/player-profile/PlayerName";
import { lmAddPlayerAction, type PerformAs, type RosterSlotType } from "./actions";
import type { PlayerSearchResult } from "@/lib/players/rankings";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

const SLOT_LABEL: Record<RosterSlotType, string> = { ACTIVE: "Active", FARM: "Farm", IR: "IR" };

/** Same debounced-typeahead shape as the deleted CommissionerAddPlayerBox
 * (and the free-agent search on the Players page) — a search box, a
 * dropdown of matches, click to add. In LM mode a destination select picks
 * which roster tier the player lands on; TM mode always adds to Active,
 * matching how addPlayerToRoster itself works for a real manager. */
export function AddPlayerStep({ leagueId, teamId, performAs }: { leagueId: string; teamId: string; performAs: PerformAs }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [destination, setDestination] = useState<RosterSlotType>("ACTIVE");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hasTyped = useRef(false);

  useEffect(() => {
    if (!hasTyped.current) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      const { results: matches } = await searchPlayersAction(q);
      if (!cancelled) setResults(matches);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  async function add(playerId: string, name: string) {
    setPending(playerId);
    setError(null);
    setMessage(null);
    const result = await lmAddPlayerAction(leagueId, teamId, playerId, performAs, performAs === "LM" ? destination : "ACTIVE");
    setPending(null);
    // Close the dropdown either way — on success there's nothing left to
    // pick, and on failure it would otherwise sit (absolutely positioned)
    // right on top of the error message below the search box.
    setResults([]);
    if (result.ok) {
      setMessage(`Added ${name} to ${SLOT_LABEL[performAs === "LM" ? destination : "ACTIVE"]}.`);
      setQuery("");
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="max-w-xl">
      {performAs === "LM" && (
        <label className="mb-3 block max-w-xs">
          <span className="text-xs text-muted">Destination</span>
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value as RosterSlotType)}
            className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          >
            <option value="ACTIVE">Active</option>
            <option value="FARM">Farm</option>
            <option value="IR">IR</option>
          </select>
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            hasTyped.current = true;
            setQuery(e.target.value);
          }}
          placeholder="Search a player to add…"
          autoComplete="off"
          className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
        />
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded border border-border bg-surface shadow-lg">
            <ul className="divide-y divide-border">
              {results.map((p) => (
                <li key={p.id}>
                  {/* A row-wide button can't contain PlayerName's own <button>, so this
                      site — unlike a plain text name — needs a clickable div instead: the
                      name opens the profile (via stopPropagation) and the rest of the row
                      still adds the player, mirroring RosterMoveBoard's "name opens the
                      modal, the row still selects" pattern. */}
                  <div
                    role="button"
                    tabIndex={pending === p.id ? -1 : 0}
                    aria-disabled={pending === p.id}
                    onClick={() => {
                      if (pending !== p.id) add(p.id, p.fullName);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && pending !== p.id) {
                        e.preventDefault();
                        add(p.id, p.fullName);
                      }
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-tint aria-disabled:opacity-50"
                  >
                    <PlayerName playerId={p.id} fullName={p.fullName} />
                    <span className="text-xs text-muted">
                      {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {error && (
        <p className="mt-2 text-sm text-danger">
          {error}
          {performAs === "TM" && " Switch to Perform as League Manager to override."}
        </p>
      )}
      {message && <p className="mt-2 text-sm text-success">{message}</p>}
    </div>
  );
}
