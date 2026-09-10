"use client";

import { useEffect, useRef, useState } from "react";
import { searchPlayersAction } from "../../players/actions";
import { addPlayerAction } from "../../players/actions";
import type { PlayerSearchResult } from "@/lib/players/rankings";
import { Button } from "@/components/Button";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

/** The owner's own "+ Add" box directly on the My Team page — same search
 * pattern as the free-agent typeahead and CommissionerAddPlayerBox, but
 * calling the normal (capped, FAAB-aware) addPlayerToRoster path. When the
 * active roster is already full, expands into the same guided "pick who to
 * drop" step as the Players page's AddPlayerCell instead of throwing a bare
 * "roster is full" error. */
export function AddPlayerBox({
  leagueId,
  teamId,
  activeCount,
  activeCap,
  activeRosterPlayers,
  onAdded,
}: {
  leagueId: string;
  teamId: string;
  activeCount: number;
  activeCap: number;
  activeRosterPlayers: { id: string; fullName: string }[];
  onAdded?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [picked, setPicked] = useState<PlayerSearchResult | null>(null);
  const [dropChoice, setDropChoice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasTyped = useRef(false);
  const isFull = activeCount >= activeCap;

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

  function choosePlayer(p: PlayerSearchResult) {
    setError(null);
    if (isFull) {
      setPicked(p);
      setResults([]);
      return;
    }
    void doAdd(p.id);
  }

  async function doAdd(playerId: string, dropPlayerId?: string) {
    setPending(true);
    setError(null);
    try {
      await addPlayerAction(leagueId, teamId, playerId, dropPlayerId);
      setQuery("");
      setResults([]);
      setPicked(null);
      setDropChoice("");
      onAdded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that player.");
    } finally {
      setPending(false);
    }
  }

  if (picked) {
    return (
      <div className="max-w-sm rounded border border-border bg-surface p-3 text-sm">
        <p className="text-muted">
          Roster full — drop who to make room for <span className="font-medium text-foreground">{picked.fullName}</span>?
        </p>
        <div className="mt-2 flex items-center gap-2">
          <select
            value={dropChoice}
            onChange={(e) => setDropChoice(e.target.value)}
            className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
          >
            <option value="">Choose player…</option>
            {activeRosterPlayers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
          <Button type="button" variant="primary" size="sm" disabled={!dropChoice || pending} onClick={() => doAdd(picked.id, dropChoice)}>
            Drop &amp; Add
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setPicked(null);
              setDropChoice("");
            }}
          >
            Cancel
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="relative max-w-sm">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          hasTyped.current = true;
          setQuery(e.target.value);
        }}
        placeholder="Search a free agent to add…"
        autoComplete="off"
        disabled={pending}
        className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue disabled:opacity-50"
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded border border-border bg-surface shadow-lg">
          <ul className="divide-y divide-border">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => choosePlayer(p)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-tint disabled:opacity-50"
                >
                  <span>{p.fullName}</span>
                  <span className="text-xs text-muted">
                    {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
