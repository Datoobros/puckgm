"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/Card";
import { resolveDraftStateAction, makeDraftPickAction } from "./actions";
import type { DraftStateView } from "@/lib/draft/mutations";

// The first client-polling UI in this app — there's no live-update
// infrastructure (no websockets, no cron fine-grained enough for a countdown)
// so the room polls resolveDraftStateAction every few seconds, which resolves
// any expired pick(s) server-side before returning the true current state.
const POLL_MS = 3000;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DraftRoom({
  leagueId,
  draftId,
  myTeamId,
  initialState,
}: {
  leagueId: string;
  draftId: string;
  myTeamId: string | null;
  initialState: DraftStateView;
}) {
  const [view, setView] = useState(initialState);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMyTurn = !!myTeamId && view.currentPick?.teamId === myTeamId;

  useEffect(() => {
    if (view.status !== "IN_PROGRESS") return;
    const id = setInterval(async () => {
      const next = await resolveDraftStateAction(draftId);
      setView(next);
      setFetchedAt(Date.now());
    }, POLL_MS);
    return () => clearInterval(id);
  }, [draftId, view.status]);

  useEffect(() => {
    if (view.status !== "IN_PROGRESS") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [view.status]);

  const msRemaining = view.currentPick ? Math.max(0, view.currentPick.msRemaining - (now - fetchedAt)) : 0;

  const filteredPool = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return view.pool.slice(0, 50);
    return view.pool.filter((p) => p.fullName.toLowerCase().includes(q)).slice(0, 50);
  }, [view.pool, search]);

  async function handlePick(playerId: string) {
    setPending(true);
    setError(null);
    try {
      const next = await makeDraftPickAction(leagueId, draftId, playerId);
      setView(next);
      setFetchedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make that pick.");
      const next = await resolveDraftStateAction(draftId);
      setView(next);
      setFetchedAt(Date.now());
    } finally {
      setPending(false);
    }
  }

  if (view.status === "COMPLETE") {
    return (
      <div className="space-y-6">
        <Card className="!bg-emerald-500/10 !border-emerald-500/20">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Draft complete.</p>
        </Card>
        <RecentPicks recentPicks={view.recentPicks} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {view.currentPick && (
        <Card className={isMyTurn ? "!border-gold !bg-gold/10" : ""}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted">
                Round {view.currentPick.round} · Pick {view.currentPick.overallPick} on the clock
              </p>
              <p className="text-lg font-semibold">
                {view.currentPick.teamName}
                {isMyTurn && <span className="ml-2 rounded bg-gold px-2 py-0.5 text-xs font-medium text-gold-foreground">Your pick</span>}
              </p>
            </div>
            <p className="font-mono text-2xl tabular-nums">{formatClock(msRemaining)}</p>
          </div>
        </Card>
      )}

      {error && (
        <Card className="!bg-red-500/10 !border-red-500/20">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </Card>
      )}

      <div>
        <input
          type="text"
          placeholder="Search available players…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
        <Card className="mt-2 !p-0 max-h-96 overflow-y-auto">
          <ul className="divide-y divide-border">
            {filteredPool.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="text-sm">
                  {p.fullName}{" "}
                  <span className="text-xs text-muted">
                    {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={!isMyTurn || pending}
                  onClick={() => handlePick(p.id)}
                  className="shrink-0 rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Draft
                </button>
              </li>
            ))}
            {filteredPool.length === 0 && <li className="px-4 py-3 text-sm text-muted">No players match.</li>}
          </ul>
        </Card>
      </div>

      <RecentPicks recentPicks={view.recentPicks} />
    </div>
  );
}

function RecentPicks({ recentPicks }: { recentPicks: DraftStateView["recentPicks"] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recent picks</p>
      {recentPicks.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No picks made yet.</p>
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <ul className="divide-y divide-border">
            {recentPicks.map((p) => (
              <li key={p.overallPick} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  <span className="text-xs text-muted">
                    R{p.round} · #{p.overallPick}
                  </span>{" "}
                  {p.teamName} — {p.playerName}
                </span>
                {p.autopicked && <span className="shrink-0 rounded bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium text-muted">AUTO</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
