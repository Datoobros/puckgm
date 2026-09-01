"use client";

import { useMemo, useState } from "react";
import { NHL_TEAM_ABBREVS } from "@/lib/nhl/client";
import { SKATER_COLUMNS, GOALIE_COLUMNS, POINTS_COLUMNS, type StatColumn } from "@/lib/players/columns";
import { addPlayerAction } from "./actions";
import type { PlayerStatsRow } from "@/lib/players/rankings";

interface RosterContext {
  leagueId: string;
  teamId: string;
  isMyTeam: boolean;
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
}: {
  rows: PlayerStatsRow[];
  rosterContext: RosterContext | null;
  ownership: Record<string, string>;
}) {
  const [position, setPosition] = useState<PositionFilter>("SKATERS");
  const [proTeam, setProTeam] = useState("ALL");
  const [availability, setAvailability] = useState<"ALL" | "AVAILABLE">("ALL");
  const [sortKey, setSortKey] = useState("points");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(0);

  const columns = position === "G" ? GOALIE_COLUMNS : SKATER_COLUMNS;
  const allColumns = [...columns, ...POINTS_COLUMNS];
  const activeSortCol = allColumns.find((c) => c.key === sortKey) ?? POINTS_COLUMNS[0];

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!matchesPosition(r.primaryPosition, position)) return false;
      if (proTeam !== "ALL" && r.currentNhlOrg !== proTeam) return false;
      if (availability === "AVAILABLE" && ownership[r.id]) return false;
      return true;
    });
  }, [rows, position, proTeam, availability, ownership]);

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

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 border-b border-black/10 pb-3 dark:border-white/10">
        <div className="flex items-center gap-1 text-sm">
          <span className="mr-1 text-zinc-500">Position:</span>
          {(["SKATERS", "F", "D", "G"] as PositionFilter[]).map((p) => (
            <button
              key={p}
              onClick={() => handlePositionChange(p)}
              className={`rounded px-2 py-1 font-medium ${
                position === p
                  ? "bg-foreground text-background"
                  : "text-zinc-500 hover:text-foreground"
              }`}
            >
              {p === "SKATERS" ? "All Skaters" : p}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-500">
          Pro Team
          <select
            value={proTeam}
            onChange={(e) => {
              setProTeam(e.target.value);
              setPage(0);
            }}
            className="rounded border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/15"
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
          <label className="flex items-center gap-2 text-sm text-zinc-500">
            Filter
            <select
              value={availability}
              onChange={(e) => {
                setAvailability(e.target.value as "ALL" | "AVAILABLE");
                setPage(0);
              }}
              className="rounded border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/15"
            >
              <option value="ALL">All</option>
              <option value="AVAILABLE">Available</option>
            </select>
          </label>
        )}

        <span className="ml-auto text-xs text-zinc-500">
          {sorted.length} player{sorted.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/10">
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
            {pageRows.map((r) => (
              <tr key={r.id} className="border-b border-black/5 dark:border-white/5">
                <td className="py-2 pr-2 font-medium">{r.fullName}</td>
                <td className="py-2 pr-2 text-zinc-500">
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
                      <span className="text-xs text-zinc-500">{ownership[r.id]}</span>
                    ) : rosterContext.isMyTeam ? (
                      <form
                        action={addPlayerAction.bind(
                          null,
                          rosterContext.leagueId,
                          rosterContext.teamId,
                          r.id,
                        )}
                      >
                        <button type="submit" className="text-xs underline">
                          Add
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-zinc-500">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={allColumns.length + 2} className="py-8 text-center text-sm text-zinc-500">
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
            className="text-zinc-500 hover:text-foreground disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-zinc-500">
            Page {pageSafe + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={pageSafe >= totalPages - 1}
            className="text-zinc-500 hover:text-foreground disabled:opacity-30"
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
        className={`whitespace-nowrap hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {col.label}
        {active && <span className="ml-0.5">{desc ? "▼" : "▲"}</span>}
      </button>
    </th>
  );
}
