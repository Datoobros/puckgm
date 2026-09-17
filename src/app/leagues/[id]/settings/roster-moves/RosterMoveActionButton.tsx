"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { lmDropPlayerAction, lmMovePlayerAction, type PerformAs, type RosterSlotType } from "./actions";
import { Button, type ButtonVariant } from "@/components/Button";

/** One row's move/drop button in Drop Player / Manage IR / Manage Farm Team
 * step-2 — calls the server action directly (client components can import a
 * "use server" function and call it like any other async function; no need
 * to thread a closure down from the server-rendered parent) and shows the
 * result inline instead of relying on a raw <form action> ignoring the
 * { ok, error } return value. */
export function RosterMoveActionButton({
  kind,
  leagueId,
  teamId,
  playerId,
  performAs,
  targetSlotType,
  label,
  variant = "secondary",
  confirmText,
}: {
  kind: "drop" | "move";
  leagueId: string;
  teamId: string;
  playerId: string;
  performAs: PerformAs;
  targetSlotType?: RosterSlotType;
  label: string;
  variant?: ButtonVariant;
  confirmText?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (confirmText && !confirm(confirmText)) return;
    setPending(true);
    setError(null);
    const result =
      kind === "drop"
        ? await lmDropPlayerAction(leagueId, teamId, playerId, performAs)
        : await lmMovePlayerAction(leagueId, teamId, playerId, performAs, targetSlotType!);
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant={variant} disabled={pending} onClick={handleClick}>
        {label}
      </Button>
      {error && (
        <span className="max-w-[240px] text-right text-xs text-danger">
          {error}
          {performAs === "TM" && " Switch to Perform as League Manager to override."}
        </span>
      )}
    </span>
  );
}
