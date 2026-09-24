"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/Card";
import { Button, Badge } from "@/components/Button";
import { PlayerName } from "@/components/player-profile/PlayerName";
import { PlayerNavList } from "@/components/player-profile/PlayerNavList";
import { resolveDraftStateAction, makeDraftPickAction, autodraftBatchAction } from "./actions";
import type { DraftStateView } from "@/lib/draft/mutations";

// The first client-polling UI in this app — there's no live-update
// infrastructure (no websockets, no cron fine-grained enough for a countdown)
// so the room polls resolveDraftStateAction every few seconds, which resolves
// any expired pick(s) server-side before returning the true current state.
const POLL_MS = 3000;

// Same tab-button filter idea as the Players page's PlayerStatsTable, scoped
// to this league's positionMode — COMBINED shows one "F" tab, SEPARATE
// shows C/L/R separately (Player.primaryPosition is NHL's single-letter
// code, same discrepancy noted in src/lib/lineups/mutations.ts).
type PositionFilter = "ALL" | "F" | "C" | "L" | "R" | "D" | "G";
const FORWARD_POSITIONS = new Set(["C", "L", "R"]);

function positionTabsFor(positionMode: "SEPARATE" | "COMBINED"): PositionFilter[] {
  return positionMode === "COMBINED" ? ["ALL", "F", "D", "G"] : ["ALL", "C", "L", "R", "D", "G"];
}

function matchesPosition(pos: string | null, filter: PositionFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "F") return pos !== null && FORWARD_POSITIONS.has(pos);
  return pos === filter;
}

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
  positionMode,
  isCommissioner,
}: {
  leagueId: string;
  draftId: string;
  myTeamId: string | null;
  initialState: DraftStateView;
  positionMode: "SEPARATE" | "COMBINED";
  isCommissioner: boolean;
}) {
  const [view, setView] = useState(initialState);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autodrafting, setAutodrafting] = useState(false);

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
    return view.pool
      .filter((p) => matchesPosition(p.primaryPosition, position))
      .filter((p) => !q || p.fullName.toLowerCase().includes(q))
      .slice(0, 50);
  }, [view.pool, search, position]);

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

  async function handleAutodraft() {
    const remaining = view.currentPick ? view.totalPicks - view.currentPick.overallPick + 1 : 0;
    if (!confirm(`Auto-draft all ${remaining} remaining picks now? This can't be undone.`)) return;
    setAutodrafting(true);
    setError(null);
    try {
      let next = view;
      while (next.status === "IN_PROGRESS") {
        next = await autodraftBatchAction(leagueId, draftId);
        setView(next);
        setFetchedAt(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't autodraft the remaining picks.");
    } finally {
      setAutodrafting(false);
    }
  }

  const progress =
    view.totalPicks > 0 ? (
      <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted">
        Round {view.currentPick?.round ?? view.totalRounds} of {view.totalRounds}
        {view.currentPick && <> · Pick {view.currentPick.overallPick} of {view.totalPicks} overall</>}
      </p>
    ) : null;

  if (view.status === "COMPLETE") {
    return (
      <div className="space-y-6">
        {progress}
        <Card className="!border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Draft complete.</p>
          {myTeamId && (
            <p className="mt-2 text-sm text-success">
              <Link href={`/leagues/${leagueId}/teams/${myTeamId}`} className="underline">
                Go to your team
              </Link>{" "}
              — your drafted roster fills into lineup slots automatically the first time you view it.
            </p>
          )}
          <p className="mt-2 text-sm text-success">
            <Link href={`/leagues/${leagueId}/draft/recap`} className="underline">
              View draft recap
            </Link>
          </p>
        </Card>
        <RecentPicks recentPicks={view.recentPicks} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {progress}

      {view.currentPick && (
        <Card className={isMyTurn ? "!border-gold !bg-gold/10" : ""}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted">
                Round {view.currentPick.round} · Pick {view.currentPick.overallPick} on the clock
              </p>
              <p className="text-lg font-semibold">
                {view.currentPick.teamName}
                {isMyTurn && (
                  <Badge tone="gold" solid className="ml-2 normal-case">
                    Your pick
                  </Badge>
                )}
              </p>
            </div>
            <p className="font-mono text-2xl tabular-nums">{formatClock(msRemaining)}</p>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted">
        The clock only runs while someone has this page open. Picks left unmade when the timer hits zero are
        auto-drafted.
      </p>

      {isCommissioner && (
        <div className="flex items-center gap-3">
          <Button type="button" variant="secondary" disabled={pending || autodrafting} onClick={handleAutodraft}>
            Autodraft remaining picks
          </Button>
          {autodrafting && (
            <span className="text-xs text-muted">
              Auto-drafting… pick {Math.min(view.currentPick?.overallPick ?? view.totalPicks, view.totalPicks)} of{" "}
              {view.totalPicks}
            </span>
          )}
        </div>
      )}

      {error && (
        <Card className="!border-danger/20 !bg-danger-tint">
          <p className="text-sm text-danger">{error}</p>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center gap-5 border-b border-border">
          {positionTabsFor(positionMode).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPosition(p)}
              className={`border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors ${
                position === p ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {p === "ALL" ? "All" : p}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search available players…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
        <Card className="mt-2 !p-0 max-h-96 overflow-y-auto">
          <ul className="divide-y divide-border">
            <PlayerNavList players={filteredPool.map((p) => ({ id: p.id, fullName: p.fullName }))}>
              {filteredPool.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="text-sm">
                    <PlayerName playerId={p.id} fullName={p.fullName} />{" "}
                    <span className="text-xs text-muted">
                      {p.primaryPosition ?? "—"} · {p.currentNhlOrg ?? "—"}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!isMyTurn || pending || autodrafting}
                    onClick={() => handlePick(p.id)}
                  >
                    Draft
                  </Button>
                </li>
              ))}
            </PlayerNavList>
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
                  {p.teamName} — <PlayerName playerId={p.playerId} fullName={p.playerName} />
                </span>
                {p.autopicked && <Badge tone="muted">Auto</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
