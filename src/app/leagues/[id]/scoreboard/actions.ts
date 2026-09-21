"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { addScoreAdjustment, removeScoreAdjustment } from "@/lib/matchups/adjustments";

// Same { ok, error } convention as src/app/leagues/[id]/settings/roster-moves/
// actions.ts — the modal shows a refusal inline instead of crashing the
// Server Action boundary, and a caller checking auth server-side (rather than
// trusting the client's own commissioner-gated render) is a real, expected
// refusal path here, not an exceptional one.
export type ScoreAdjustmentResult = { ok: true } | { ok: false; error: string };

export async function addScoreAdjustmentAction(
  leagueId: string,
  matchupPeriodId: string,
  teamId: string,
  points: number,
  reason: string,
): Promise<ScoreAdjustmentResult> {
  const { userId } = await auth.protect();
  try {
    await addScoreAdjustment({ leagueId, matchupPeriodId, teamId, points, reason, callerUserId: userId });
    revalidatePath(`/leagues/${leagueId}/scoreboard`);
    revalidatePath(`/leagues/${leagueId}/standings`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

export async function removeScoreAdjustmentAction(leagueId: string, id: string): Promise<ScoreAdjustmentResult> {
  const { userId } = await auth.protect();
  try {
    await removeScoreAdjustment({ id, callerUserId: userId });
    revalidatePath(`/leagues/${leagueId}/scoreboard`);
    revalidatePath(`/leagues/${leagueId}/standings`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
