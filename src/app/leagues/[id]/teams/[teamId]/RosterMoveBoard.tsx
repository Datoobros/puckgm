"use client";

import { useState, type ReactNode } from "react";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { Card, SectionLabel } from "@/components/Card";
import { moveTeamPlayerAction, sendToFarmAction, dropPlayerAction } from "./actions";
import { AddPlayerBox } from "./AddPlayerBox";
import type {
  MoveDestinationInput,
  MoveOption,
  MoveSourceTier,
  MoveBoardRow,
  MoveBoardOccupantRow,
  MoveBoardEmptyRow,
  MoveBoardIrRow,
  MoveBoardIrOccupantRow,
} from "./moveTypes";

const badgeClasses: Record<string, string> = {
  muted: "bg-surface-tint text-muted",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export function RosterMoveBoard({
  leagueId,
  teamId,
  date,
  skaterColumnDefs,
  goalieColumnDefs,
  skaterRows,
  goalieRows,
  irRows,
  irLabel,
  moveOptionsByPlayerId,
  sourceTierByPlayerId,
  farmSection,
  activeCap,
}: {
  leagueId: string;
  teamId: string;
  date: string;
  skaterColumnDefs: { key: string; label: string }[];
  goalieColumnDefs: { key: string; label: string }[];
  skaterRows: MoveBoardRow[];
  goalieRows: MoveBoardRow[];
  irRows: MoveBoardIrRow[];
  irLabel: ReactNode;
  moveOptionsByPlayerId: Record<string, MoveOption[]>;
  sourceTierByPlayerId: Record<string, MoveSourceTier>;
  farmSection: ReactNode;
  activeCap: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dropMode, setDropMode] = useState(false);
  const [confirmDropId, setConfirmDropId] = useState<string | null>(null);
  const [dropPending, setDropPending] = useState(false);

  // Active roster occupants only — every occupant row across both tables,
  // used both for the "roster full?" check and the AddPlayerBox's
  // drop-to-make-room picker. Farm/IR players are separate tiers, not
  // counted against the active cap.
  const activeOccupants = [...skaterRows, ...goalieRows].filter(
    (r): r is MoveBoardOccupantRow => r.kind === "occupant",
  );

  async function handleDrop(playerId: string) {
    setDropPending(true);
    setError(null);
    try {
      await dropPlayerAction(leagueId, teamId, playerId);
      setConfirmDropId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't drop that player.");
    } finally {
      setDropPending(false);
    }
  }

  const options = selected ? (moveOptionsByPlayerId[selected] ?? []) : [];
  const destinationByRowKey = new Map(options.map((o) => [o.rowKey, o.destination] as const));

  function toggleSelect(playerId: string) {
    setError(null);
    setSelected((cur) => (cur === playerId ? null : playerId));
  }

  async function handleHere(rowKey: string) {
    if (!selected) return;
    const destination = destinationByRowKey.get(rowKey);
    if (!destination) return;
    const tier = sourceTierByPlayerId[selected];
    setPending(true);
    setError(null);
    try {
      await moveTeamPlayerAction(leagueId, teamId, date, selected, tier, destination as MoveDestinationInput);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't complete that move.");
    } finally {
      setPending(false);
    }
  }

  function moveButtonCell(playerId: string, rowKey: string, canMove: boolean, locked: boolean) {
    const isSelected = selected === playerId;
    const isDestination = selected !== null && !isSelected && destinationByRowKey.has(rowKey);

    if (isSelected) {
      return (
        <button
          type="button"
          onClick={() => toggleSelect(playerId)}
          disabled={pending}
          className="rounded-full bg-navy px-3 py-1 text-xs font-medium text-navy-foreground hover:opacity-90 disabled:opacity-50"
        >
          Cancel
        </button>
      );
    }
    if (isDestination) {
      return (
        <button
          type="button"
          onClick={() => handleHere(rowKey)}
          disabled={pending}
          className="rounded-full border border-blue px-3 py-1 text-xs font-medium text-blue hover:bg-blue/10 disabled:opacity-50"
        >
          Here
        </button>
      );
    }
    if (selected === null && canMove && !locked) {
      return (
        <button
          type="button"
          onClick={() => toggleSelect(playerId)}
          className="rounded-full bg-navy px-3 py-1 text-xs font-medium text-navy-foreground hover:opacity-90"
        >
          Move
        </button>
      );
    }
    return null;
  }

  function hereOnlyCell(rowKey: string) {
    if (selected === null || !destinationByRowKey.has(rowKey)) return null;
    return (
      <button
        type="button"
        onClick={() => handleHere(rowKey)}
        disabled={pending}
        className="rounded-full border border-blue px-3 py-1 text-xs font-medium text-blue hover:bg-blue/10 disabled:opacity-50"
      >
        Here
      </button>
    );
  }

  function renderTable(rows: MoveBoardRow[], columnDefs: { key: string; label: string }[], emptyText: string) {
    if (rows.length === 0) {
      return (
        <Card>
          <p className="text-sm text-muted">{emptyText}</p>
        </Card>
      );
    }
    return (
      <Card className="overflow-x-auto !p-0">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-2 pl-4 pr-2 font-medium">Player</th>
              <th className="py-2 pr-2 font-medium">Opponent</th>
              {columnDefs.map((col) => (
                <th key={col.key} className="py-2 pr-2 text-right font-medium">
                  {col.label}
                </th>
              ))}
              <th className="py-2 pr-4" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const rowClass = `border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface-tint" : ""} ${
                row.isGroupStart ? "border-t-2 border-t-blue" : ""
              }`;

              if (row.kind === "empty") {
                const r = row as MoveBoardEmptyRow;
                return (
                  <tr key={r.rowKey} className={rowClass}>
                    <td className="py-2 pl-4 pr-2 text-muted" colSpan={2 + columnDefs.length}>
                      {r.label} — Empty
                    </td>
                    <td className="py-2 pr-4 text-right">{hereOnlyCell(r.rowKey)}</td>
                  </tr>
                );
              }

              const r = row as MoveBoardOccupantRow;
              const hasOptions = (moveOptionsByPlayerId[r.playerId]?.length ?? 0) > 0;
              return (
                <tr key={r.rowKey} className={rowClass}>
                  <td className="py-2 pl-4 pr-2 font-medium">
                    <span className="flex items-center gap-2">
                      <PlayerHeadshot url={r.headshotUrl} alt={r.fullName} size={28} />
                      {r.fullName}
                      {r.badges.map((b) => (
                        <span
                          key={b.label}
                          title={b.title}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeClasses[b.tone]}`}
                        >
                          {b.label}
                        </span>
                      ))}
                      <span className="text-xs text-muted">{r.currentNhlOrg ?? "—"}</span>
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-muted">{r.opponentLabel}</td>
                  {r.statCells.map((c) => (
                    <td key={c.key} className="py-2 pr-2 text-right tabular-nums">
                      {c.value}
                    </td>
                  ))}
                  <td className="py-2 pr-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {dropMode ? (
                        r.canDrop &&
                        (confirmDropId === r.playerId ? (
                          <>
                            <span className="text-xs text-muted">Drop {r.fullName}?</span>
                            <button
                              type="button"
                              disabled={dropPending}
                              onClick={() => handleDrop(r.playerId)}
                              className="rounded-full bg-red-500 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDropId(null)}
                              className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDropId(r.playerId)}
                            className="rounded-full border border-red-500/50 px-3 py-1 text-xs text-red-500 hover:bg-red-500/10"
                          >
                            − Drop
                          </button>
                        ))
                      ) : (
                        <>
                          {r.canSendToFarm && (
                            <form action={sendToFarmAction.bind(null, leagueId, teamId, r.playerId)}>
                              <button type="submit" className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-tint">
                                → Farm
                              </button>
                            </form>
                          )}
                          {moveButtonCell(r.playerId, r.rowKey, hasOptions, r.locked)}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    );
  }

  function renderIrList() {
    if (irRows.length === 0) {
      return (
        <Card>
          <p className="text-sm text-muted">No players on IR.</p>
        </Card>
      );
    }
    return (
      <Card className="!p-0 overflow-hidden">
        <ul className="divide-y divide-border">
          {irRows.map((row) => {
            if (row.kind === "empty") {
              return (
                <li key={row.rowKey} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted">IR — Empty</span>
                  {hereOnlyCell(row.rowKey)}
                </li>
              );
            }
            const r = row as MoveBoardIrOccupantRow;
            const hasOptions = (moveOptionsByPlayerId[r.playerId]?.length ?? 0) > 0;
            return (
              <li key={r.rowKey} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <PlayerHeadshot url={r.headshotUrl} alt={r.fullName} size={28} />
                  {r.fullName}
                  <span className="text-xs text-muted">{r.currentNhlOrg ?? "—"}</span>
                  <span className="rounded bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    {r.officialRosterStatus ?? "IR"}
                  </span>
                </span>
                {hasOptions ? (
                  moveButtonCell(r.playerId, r.rowKey, true, false)
                ) : r.disabledReason ? (
                  <span className="text-xs text-muted" title={r.disabledReason}>
                    {r.disabledReason}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }

  return (
    <>
      <div key="action-bar" className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setAddOpen((o) => !o);
            setDropMode(false);
            setConfirmDropId(null);
          }}
          className="rounded-full bg-gold px-3 py-1 text-xs font-medium text-gold-foreground hover:opacity-90"
        >
          + Add
        </button>
        <button
          type="button"
          onClick={() => {
            setDropMode((m) => !m);
            setAddOpen(false);
            setConfirmDropId(null);
          }}
          className={`rounded-full border px-3 py-1 text-xs ${
            dropMode ? "border-red-500 text-red-500" : "border-border hover:bg-surface-tint"
          }`}
        >
          − Drop
        </button>
        {dropMode && <span className="text-xs text-muted">Pick a player below to drop.</span>}
      </div>
      {addOpen && (
        <div className="mt-3">
          <AddPlayerBox
            leagueId={leagueId}
            teamId={teamId}
            activeCount={activeOccupants.length}
            activeCap={activeCap}
            activeRosterPlayers={activeOccupants.map((o) => ({ id: o.playerId, fullName: o.fullName }))}
            onAdded={() => setAddOpen(false)}
          />
        </div>
      )}
      <div key="skaters" className="mt-6">
        <SectionLabel>Skaters</SectionLabel>
        {renderTable(skaterRows, skaterColumnDefs, "No skaters rostered yet.")}
      </div>
      <div key="goalies" className="mt-6">
        <SectionLabel>Goalies</SectionLabel>
        {renderTable(goalieRows, goalieColumnDefs, "No goalies rostered yet.")}
      </div>
      {farmSection}
      <div key="ir" className="mt-6">
        <SectionLabel>{irLabel}</SectionLabel>
        {renderIrList()}
      </div>
      {error && (
        <p key="move-error" className="mt-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </>
  );
}
