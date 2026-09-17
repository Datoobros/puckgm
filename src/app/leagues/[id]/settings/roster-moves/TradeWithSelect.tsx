"use client";

import { useRouter } from "next/navigation";

/** The Make Trade step's own "Trade with" picker — separate from
 * TradeBuilder's internal one (hidden in commissioner mode, since that one
 * navigates to /trades/new). Changing it pushes a new `with` query param on
 * this same roster-moves URL rather than leaving the page. */
export function TradeWithSelect({
  leagueId,
  teamId,
  otherTeams,
  currentWithId,
}: {
  leagueId: string;
  teamId: string;
  otherTeams: { id: string; name: string }[];
  currentWithId?: string;
}) {
  const router = useRouter();

  return (
    <select
      value={currentWithId ?? ""}
      onChange={(e) =>
        router.push(`/leagues/${leagueId}/settings/roster-moves?action=TRADE&team=${teamId}&as=LM&with=${e.target.value}`)
      }
      className="mt-1 block w-full max-w-xs rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
    >
      <option value="" disabled>
        Select a team…
      </option>
      {otherTeams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
