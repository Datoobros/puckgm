"use client";

import { useState } from "react";

const SEPARATE_POSITIONS = [
  { key: "posC", label: "C", defaultValue: 2 },
  { key: "posLW", label: "LW", defaultValue: 2 },
  { key: "posRW", label: "RW", defaultValue: 2 },
  { key: "posD", label: "D", defaultValue: 4 },
  { key: "posG", label: "G", defaultValue: 2 },
  { key: "posUTIL", label: "UTIL", defaultValue: 1 },
  { key: "posBENCH", label: "Bench", defaultValue: 6 },
];

const COMBINED_POSITIONS = [
  { key: "posF", label: "F", defaultValue: 6 },
  { key: "posD", label: "D", defaultValue: 4 },
  { key: "posG", label: "G", defaultValue: 2 },
  { key: "posUTIL", label: "UTIL", defaultValue: 1 },
  { key: "posBENCH", label: "Bench", defaultValue: 6 },
];

export function LeagueTypeAndRosterFields() {
  const [leagueType, setLeagueType] = useState<"DYNASTY" | "REDRAFT">("DYNASTY");
  const [positionMode, setPositionMode] = useState<"SEPARATE" | "COMBINED">("SEPARATE");
  const positions = positionMode === "COMBINED" ? COMBINED_POSITIONS : SEPARATE_POSITIONS;

  const selectClass = "mt-1 w-full rounded border border-border bg-white px-2 py-2 text-sm text-black";
  const numberClass = "mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-center text-sm outline-none focus:border-blue";

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm text-muted">League type</span>
          <select
            name="leagueType"
            value={leagueType}
            onChange={(e) => setLeagueType(e.target.value as "DYNASTY" | "REDRAFT")}
            className={selectClass}
          >
            <option value="DYNASTY">Dynasty — farm team, rosters carry over every year</option>
            <option value="REDRAFT">Redraft — no farm team, full reset and re-draft every year</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-muted">Forward positions</span>
          <select
            name="positionMode"
            value={positionMode}
            onChange={(e) => setPositionMode(e.target.value as "SEPARATE" | "COMBINED")}
            className={selectClass}
          >
            <option value="SEPARATE">Separate (C / LW / RW)</option>
            <option value="COMBINED">Combined (one Forwards slot)</option>
          </select>
        </label>
      </div>

      <fieldset>
        <legend className="text-sm text-muted">
          Active roster composition (locked forever once created)
        </legend>
        <div className="mt-2 grid grid-cols-4 gap-3 sm:grid-cols-7">
          {positions.map((pos) => (
            <label key={pos.key} className="block text-center">
              <span className="text-xs text-muted">{pos.label}</span>
              <input
                name={pos.key}
                type="number"
                min={0}
                required
                defaultValue={pos.defaultValue}
                className={numberClass}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        {leagueType === "REDRAFT" ? (
          <input type="hidden" name="farmSlots" value={0} />
        ) : (
          <label className="block">
            <span className="text-sm text-muted">Farm slots</span>
            <input
              name="farmSlots"
              type="number"
              min={0}
              defaultValue={6}
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
          </label>
        )}
        <label className="block">
          <span className="text-sm text-muted">IR slots</span>
          <input
            name="irSlots"
            type="number"
            min={0}
            defaultValue={2}
            className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
          />
        </label>
      </div>
    </>
  );
}
