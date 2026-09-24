"use client";

import { useEffect, useMemo, useState } from "react";
import { NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import { submitFaBidAction, toggleWatchlistAction } from "./actions";
import type { PlayerStatsRow } from "@/lib/players/rankings";
import { Button, Badge } from "@/components/Button";
import { PlayerNavList } from "@/components/player-profile/PlayerNavList";
import { PlayerName } from "@/components/player-profile/PlayerName";
import { AddPlayerCell } from "./AddPlayerCell";

interface RosterContext {
  leagueId: string;
  teamId: string;
  isMyTeam: boolean;
  activeCount: number;
  activeCap: number;
  activeRosterPlayers: { id: string; fullName: string }[];
}

interface FaabContext {
  minBid: number;
  maxBid: number | null;
  pendingPlayerIds: string[];
}

type PositionFilter = "SKATERS" | "F" | "D" | "G";

// Player.primaryPosition is stored as NHL's single-letter positionCode
// ("C"/"L"/"R"/"D"/"G"), not "LW"/"RW" — see src/lib/lineups/mutations.ts
// for the same discrepancy.
const FORWARD_POSITIONS = new Set(["C", "L", "R"]);

function matchesPosition(pos: string | null, filter: PositionFilter): boolean {
  if (filter === "SKATERS") return pos !== "G";
  if (filter === "F") return pos !== null && FORWARD_POSITIONS.has(pos);
  if (filter === "D") return pos === "D";
  return pos === "G";
}

type Column = StatColumn;

const PAGE_SIZE = 25;

export function PlayerStatsTable({
  rows,
  rosterContext,
  ownership,
  leagueId,
  freeAgencyOpen = true,
  watchlistedIds = [],
  faab = null,
}: {
  rows: PlayerStatsRow[];
  rosterContext: RosterContext | null;
  ownership: Record<string, string>;
  leagueId: string;
  /** Issue #5 — free agency locked until the draft (src/lib/draft/
   * mutations.ts's getFreeAgencyStatus). Defaults true so any other caller
   * of this table (none currently) isn't silently gated. */
  freeAgencyOpen?: boolean;
  watchlistedIds?: string[];
  faab?: FaabContext | null;
}) {
  const [position, setPosition] = useState<PositionFilter>("SKATERS");
  const [proTeam, setProTeam] = useState("ALL");
  const [availability, setAvailability] = useState<"ALL" | "AVAILABLE" | "WATCHLIST">("ALL");
  const [sortKey, setSortKey] = useState("points");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(0);
  const [watching, setWatching] = useState<Set<string>>(new Set(watchlistedIds));

  // watchlistedIds only changes when the Server Component re-renders (a
  // navigation, or router.refresh() — e.g. from the player-profile modal's
  // own watchlist star) — useState's initial value alone won't pick that
  // up, so this resyncs local state whenever the parent actually hands down
  // a new list.
  useEffect(() => {
    setWatching(new Set(watchlistedIds));
  }, [watchlistedIds]);

  const columns = position === "G" ? GOALIE_COLUMNS : SKATER_COLUMNS;
  const allColumns = [...columns, ...POINTS_COLUMNS];
  const activeSortCol = allColumns.find((c) => c.key === sortKey) ?? POINTS_COLUMNS[0];

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!matchesPosition(r.primaryPosition, position)) return false;
      if (proTeam !== "ALL" && r.currentNhlOrg !== proTeam) return false;
      if (availability === "AVAILABLE" && ownership[r.id]) return false;
      if (availability === "WATCHLIST" && !watching.has(r.id)) return false;
      return true;
    });
  }, [rows, position, proTeam, availability, ownership, watching]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const diff = activeSortCol.get(a) - activeSortCol.get(b);
      return sortDesc ? -diff : diff;
    });
    return copy;
  }, [filtered, activeSortCol, sortDesc]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);

  function handleSort(key: string) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
    setPage(0);
  }

  function handlePositionChange(p: PositionFilter) {
    setPosition(p);
    setSortKey("points");
    setSortDesc(true);
    setPage(0);
  }

  async function handleToggleWatch(playerId: string) {
    setWatching((cur) => {
      const next = new Set(cur);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
    try {
      await toggleWatchlistAction(leagueId, playerId);
    } catch {
      // Revert on failure — optimistic toggle above assumed success.
      setWatching((cur) => {
        const next = new Set(cur);
        if (next.has(playerId)) next.delete(playerId);
        else next.add(playerId);
        return next;
      });
    }
  }

  return (
    <div>
      <div className="flex items-center gap-5 border-b border-border">
        {(["SKATERS", "F", "D", "G"] as PositionFilter[]).map((p) => (
          <button
            key={p}
            onClick={() => handlePositionChange(p)}
            className={`border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors ${
              position === p ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {p === "SKATERS" ? "All Skaters" : p}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted">
          Pro Team
          <select
            value={proTeam}
            onChange={(e) => {
              setProTeam(e.target.value);
              setPage(0);
            }}
            className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
          >
            <option value="ALL">All</option>
            {NHL_TEAM_ABBREVS.map((abbrev) => (
              <option key={abbrev} value={abbrev}>
                {abbrev}
              </option>
            ))}
          </select>
        </label>

        {rosterContext && (
          <label className="flex items-center gap-2 text-sm text-muted">
            Filter
            <select
              value={availability}
              onChange={(e) => {
                setAvailability(e.target.value as "ALL" | "AVAILABLE" | "WATCHLIST");
                setPage(0);
              }}
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            >
              <option value="ALL">All</option>
              <option value="AVAILABLE">Available</option>
              <option value="WATCHLIST">My Watchlist</option>
            </select>
          </label>
        )}

        <span className="ml-auto text-xs text-muted">
          {sorted.length} player{sorted.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-2 pr-2 font-medium">Player</th>
              <th className="py-2 pr-2 font-medium">Team</th>
              {allColumns.map((col) => (
                <SortableHeader
                  key={col.key}
                  col={col}
                  active={sortKey === col.key}
                  desc={sortDesc}
                  onClick={() => handleSort(col.key)}
                />
              ))}
              {rosterContext && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            <PlayerNavList players={pageRows.map((r) => ({ id: r.id, fullName: r.fullName }))}>
            {pageRows.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className="py-2 pr-2 font-medium">
                  <span className="flex items-center gap-2">
                    <PlayerHeadshot url={r.headshotUrl} alt={r.fullName} size={28} />
                    <PlayerName playerId={r.id} fullName={r.fullName} />
                    {r.officialRosterStatus === "IR" && (
                      <Badge tone="danger" title="Officially on Injured Reserve — eligible to be placed on your IR slot">
                        IR
                      </Badge>
                    )}
                    {rosterContext && (
                      <button
                        type="button"
                        onClick={() => handleToggleWatch(r.id)}
                        title={watching.has(r.id) ? "Remove from watchlist" : "Add to watchlist"}
                        className={`text-sm ${watching.has(r.id) ? "text-gold" : "text-muted/40 hover:text-muted"}`}
                      >
                        {watching.has(r.id) ? "★" : "☆"}
                      </button>
                    )}
                  </span>
                </td>
                <td className="py-2 pr-2 text-muted">
                  {r.primaryPosition ?? "—"} · {r.currentNhlOrg ?? "—"}
                </td>
                {allColumns.map((col) => (
                  <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                    {col.format ? col.format(col.get(r)) : col.get(r)}
                  </td>
                ))}
                {rosterContext && (
                  <td className="py-2 text-right">
                    {ownership[r.id] ? (
                      <span className="text-xs text-muted">{ownership[r.id]}</span>
                    ) : !rosterContext.isMyTeam ? (
                      <span className="text-xs text-muted">—</span>
                    ) : !freeAgencyOpen ? (
                      <span className="text-xs text-muted" title="Free agency is closed until the draft is complete">
                        —
                      </span>
                    ) : faab ? (
                      faab.pendingPlayerIds.includes(r.id) ? (
                        <span className="text-xs text-muted">Bid pending</span>
                      ) : (
                        <form
                          action={submitFaBidAction.bind(null, rosterContext.leagueId, r.id)}
                          className="flex items-center justify-end gap-1"
                        >
                          <input
                            name="amount"
                            type="number"
                            min={faab.minBid}
                            max={faab.maxBid ?? undefined}
                            defaultValue={faab.minBid}
                            required
                            className="w-14 rounded border border-border bg-surface px-1 py-0.5 text-xs text-foreground"
                          />
                          <select
                            name="targetSlot"
                            defaultValue="ACTIVE"
                            className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-foreground"
                          >
                            <option value="ACTIVE">Active</option>
                            <option value="FARM">Farm</option>
                          </select>
                          <Button type="submit" variant="ghost">Bid</Button>
                        </form>
                      )
                    ) : (
                      <AddPlayerCell
                        leagueId={rosterContext.leagueId}
                        teamId={rosterContext.teamId}
                        playerId={r.id}
                        activeCount={rosterContext.activeCount}
                        activeCap={rosterContext.activeCap}
                        activeRosterPlayers={rosterContext.activeRosterPlayers}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
            </PlayerNavList>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={allColumns.length + 2} className="py-8 text-center text-sm text-muted">
                  No players match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={pageSafe === 0}
            className="text-muted hover:text-foreground disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-muted">
            Page {pageSafe + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={pageSafe >= totalPages - 1}
            className="text-muted hover:text-foreground disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function SortableHeader({
  col,
  active,
  desc,
  onClick,
}: {
  col: Column;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <th className="py-2 pr-2 text-right font-medium">
      <button
        onClick={onClick}
        className={`whitespace-nowrap hover:text-foreground ${active ? "text-blue" : ""}`}
      >
        {col.label}
        {active && <span className="ml-0.5">{desc ? "▼" : "▲"}</span>}
      </button>
    </th>
  );
}
