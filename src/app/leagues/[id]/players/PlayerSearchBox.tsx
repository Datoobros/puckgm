"use client";

import { useEffect, useRef, useState } from "react";
import { searchPlayersAction } from "./actions";
import type { PlayerSearchResult } from "@/lib/players/rankings";

// Debounced typeahead over the same exhaustive name search the plain <form
// method="get"> already used (?q=, src/app/leagues/[id]/players/page.tsx) —
// this just previews a handful of matches before the user commits to a full
// search. No player photos: no headshot data source exists anywhere in this
// app.
const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

export function PlayerSearchBox({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Landing on this page with a query already in the URL (e.g. after
  // submitting a search) shouldn't pop the dropdown back open — only actual
  // typing should trigger a new lookup.
  const hasTyped = useRef(false);

  useEffect(() => {
    if (!hasTyped.current) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setTotal(0);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      const { results: matches, total: count } = await searchPlayersAction(q);
      if (!cancelled) {
        setResults(matches);
        setTotal(count);
        setOpen(true);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  function submitFor(name: string) {
    setQuery(name);
    setOpen(false);
    // Let the input's value update flush before submitting.
    requestAnimationFrame(() => formRef.current?.requestSubmit());
  }

  return (
    <div className="relative max-w-sm">
      <form ref={formRef} method="get" className="flex gap-2">
        <input
          type="text"
          name="q"
          value={query}
          onChange={(e) => {
            hasTyped.current = true;
            setQuery(e.target.value);
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Player Name"
          autoComplete="off"
          className="flex-1 rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
        />
        <button type="submit" className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground">
          Search
        </button>
      </form>

      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded border border-border bg-surface shadow-lg">
          <ul className="divide-y divide-border">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onMouseDown={() => submitFor(p.fullName)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-tint"
                >
                  <span>{p.fullName}</span>
                  <span className="text-xs text-muted">
                    {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onMouseDown={() => {
              setOpen(false);
              requestAnimationFrame(() => formRef.current?.requestSubmit());
            }}
            className="block w-full border-t border-border px-3 py-2 text-left text-xs text-blue hover:bg-surface-tint"
          >
            View {total} result{total === 1 ? "" : "s"} for &quot;{query.trim()}&quot;
          </button>
        </div>
      )}
    </div>
  );
}
