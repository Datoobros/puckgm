import Link from "next/link";
import type { TeamScheduleRow } from "@/lib/matchups/standings";
import { Card } from "@/components/Card";

/** Shared between the dedicated /schedule page and the team page's Schedule
 * tab — same content, one place, per the redesign plan. */
export function TeamScheduleList({ leagueId, rows }: { leagueId: string; rows: TeamScheduleRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">No schedule yet — the commissioner can generate one from the League page.</p>
      </Card>
    );
  }

  return (
    <Card className="!p-0 overflow-hidden">
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.periodNo} className="flex items-center justify-between px-4 py-3 text-sm">
            <span>
              <span className="text-xs text-muted">
                {r.isPlayoffs ? r.roundLabel : `Week ${r.periodNo}`}
                {" · "}
                {r.startDate.toISOString().slice(0, 10)}
              </span>
              <br />
              {r.bye ? (
                <span className="text-muted">Bye</span>
              ) : (
                <>
                  <span className="text-xs text-muted">{r.isHome ? "vs" : "@"} </span>
                  <Link href={`/leagues/${leagueId}/teams/${r.opponentTeamId}`} className="font-medium hover:underline">
                    {r.opponentTeamName}
                  </Link>
                </>
              )}
            </span>
            {!r.bye && r.final && (
              <span className={`tabular-nums text-sm ${r.myScore >= r.opponentScore ? "font-semibold text-foreground" : "text-muted"}`}>
                {r.myScore.toFixed(1)} – {r.opponentScore.toFixed(1)}
              </span>
            )}
            {!r.bye && !r.final && <span className="text-xs text-muted">Upcoming</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
