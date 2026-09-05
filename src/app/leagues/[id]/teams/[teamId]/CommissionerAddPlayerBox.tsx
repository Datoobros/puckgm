"use client";

import { useEffect, useRef, useState } from "react";
import { searchPlayersAction } from "../../players/actions";
import { commissionerAddPlayerAction } from "./actions";
import type { PlayerSearchResult } from "@/lib/players/rankings";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

/** Commissioner-only direct add — full override, no cap/ownership UI check
 * beyond what commissionerAddPlayer itself enforces server-side. Reuses the
 * same lightweight search the free-agent typeahead uses
 * (src/app/leagues/[id]/players/PlayerSearchBox.tsx). */
export function CommissionerAddPlayerBox({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
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
    try {
      await commissionerAddPlayerAction(leagueId, teamId, playerId);
      setMessage(`Added ${name}.`);
      setResults([]);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that player.");
    } finally {
      setPending(null);
    }
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
        placeholder="Search a player to add directly…"
        autoComplete="off"
        className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
      />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      {message && <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">{message}</p>}
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded border border-border bg-surface shadow-lg">
          <ul className="divide-y divide-border">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending === p.id}
                  onClick={() => add(p.id, p.fullName)}
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
