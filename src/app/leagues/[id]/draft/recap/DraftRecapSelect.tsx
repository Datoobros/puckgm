"use client";

import { useRouter } from "next/navigation";

export function DraftRecapSelect({
  leagueId,
  drafts,
  selectedDraftId,
}: {
  leagueId: string;
  drafts: { id: string; label: string }[];
  selectedDraftId: string;
}) {
  const router = useRouter();

  return (
    <select
      value={selectedDraftId}
      onChange={(e) => router.push(`/leagues/${leagueId}/draft/recap?draft=${e.target.value}`)}
      className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
    >
      {drafts.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </select>
  );
}
