"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { TeamLogo } from "@/components/TeamLogo";
import { Card } from "@/components/Card";

export interface SeasonStatsRow {
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  isMyTeam: boolean;
  goals: number;
  assists: number;
  sog: number;
  hits: number;
  blockedShots: number;
  wins: number;
  goalsAgainst: number;
  saves: number;
  shutouts: number;
  otl: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: string;
  moves: number;
}

interface Column {
  key: string;
  label: string;
  get: (r: SeasonStatsRow) => number;
  format?: (v: number) => string;
}

const SKATER_COLUMNS: Column[] = [
  { key: "goals", label: "G", get: (r) => r.goals },
  { key: "assists", label: "A", get: (r) => r.assists },
  { key: "sog", label: "SOG", get: (r) => r.sog },
  { key: "hits", label: "HIT", get: (r) => r.hits },
  { key: "blockedShots", label: "BLK", get: (r) => r.blockedShots },
];

const GOALIE_COLUMNS: Column[] = [
  { key: "wins", label: "W", get: (r) => r.wins },
  { key: "goalsAgainst", label: "GA", get: (r) => r.goalsAgainst },
  { key: "saves", label: "SV", get: (r) => r.saves },
  { key: "shutouts", label: "SO", get: (r) => r.shutouts },
  { key: "otl", label: "OTL", get: (r) => r.otl },
];

const TAIL_COLUMNS: Column[] = [
  { key: "pointsFor", label: "PF", get: (r) => r.pointsFor, format: (v) => v.toFixed(1) },
  { key: "pointsAgainst", label: "PA", get: (r) => r.pointsAgainst, format: (v) => v.toFixed(1) },
  { key: "moves", label: "MOVES", get: (r) => r.moves },
];

const ALL_COLUMNS = [...SKATER_COLUMNS, ...GOALIE_COLUMNS, ...TAIL_COLUMNS];

export function SeasonStatsTable({ rows, leagueId }: { rows: SeasonStatsRow[]; leagueId: string }) {
  const [sortKey, setSortKey] = useState("pointsFor");
  const [sortDesc, setSortDesc] = useState(true);

  const activeCol = ALL_COLUMNS.find((c) => c.key === sortKey) ?? TAIL_COLUMNS[0];

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const diff = activeCol.get(a) - activeCol.get(b);
      return sortDesc ? -diff : diff;
    });
    return copy;
  }, [rows, activeCol, sortDesc]);

  function handleSort(key: string) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  function headerCell(col: Column) {
    const active = col.key === sortKey;
    return (
      <th key={col.key} className="py-2 pr-2 text-right font-medium">
        <button
          type="button"
          onClick={() => handleSort(col.key)}
          className={`underline decoration-dotted underline-offset-2 hover:text-foreground ${active ? "text-foreground" : ""}`}
          title={`Sort by ${col.label}`}
        >
          {col.label}
          {active && <span className="ml-0.5">{sortDesc ? "▾" : "▴"}</span>}
        </button>
      </th>
    );
  }

  return (
    <Card className="overflow-x-auto !p-0">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-center text-[10px] uppercase tracking-wide text-muted">
            <th colSpan={2} />
            <th colSpan={SKATER_COLUMNS.length} className="pb-1 font-medium">
              Skaters
            </th>
            <th colSpan={GOALIE_COLUMNS.length} className="pb-1 font-medium">
              Goalies
            </th>
            <th colSpan={TAIL_COLUMNS.length + 1} />
          </tr>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pl-4 pr-2 font-medium">Rk</th>
            <th className="py-2 pr-2 font-medium">Team</th>
            {SKATER_COLUMNS.map(headerCell)}
            {GOALIE_COLUMNS.map(headerCell)}
            {TAIL_COLUMNS.map(headerCell)}
            <th className="py-2 pr-4 text-right font-medium">STRK</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.teamId} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface-tint" : ""}`}>
              <td className="py-2 pl-4 pr-2 text-muted tabular-nums">{i + 1}</td>
              <td className="py-2 pr-2 font-medium">
                <Link
                  href={`/leagues/${leagueId}/teams/${r.teamId}`}
                  className={`flex items-center gap-2 hover:underline ${r.isMyTeam ? "text-blue" : ""}`}
                >
                  <TeamLogo url={r.logoUrl} alt={r.teamName} size={20} />
                  {r.teamName}
                </Link>
              </td>
              {ALL_COLUMNS.map((col) => (
                <td key={col.key} className="py-2 pr-2 text-right tabular-nums">
                  {col.format ? col.format(col.get(r)) : col.get(r)}
                </td>
              ))}
              <td className="py-2 pr-4 text-right tabular-nums">{r.streak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
