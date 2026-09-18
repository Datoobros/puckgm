"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetDraftAction } from "./actions";
import { Button } from "@/components/Button";

export function ResetDraftConfirmForm({ leagueId, draftId, leagueName }: { leagueId: string; draftId: string; leagueName: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const matches = value.trim().length > 0 && value === leagueName;

  async function handleClick() {
    setPending(true);
    setError(null);
    const result = await resetDraftAction(leagueId, draftId, value);
    setPending(false);
    if (result.ok) {
      setDone(true);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  if (done) {
    return <p className="text-sm font-medium text-success">Draft reset — it&apos;s back in Setup.</p>;
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs text-muted">
        Type the league name (<span className="font-medium text-foreground">{leagueName}</span>) to confirm:
      </label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={leagueName}
          className="w-64 rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        />
        <Button type="button" variant="danger" size="sm" disabled={!matches || pending} onClick={handleClick}>
          {pending ? "Resetting…" : "Reset Draft"}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
