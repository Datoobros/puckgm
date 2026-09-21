"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { updatePeriodMatchups } from "@/lib/matchups/mutations";

// Same { ok, error } convention as src/app/leagues/[id]/scoreboard/actions.ts
// — the editor shows a refusal inline instead of crashing the Server Action
// boundary.
export type UpdatePeriodMatchupsResult = { ok: true } | { ok: false; error: string };

export async function updatePeriodMatchupsAction(
  leagueId: string,
  periodId: string,
  pairs: { homeTeamId: string; awayTeamId: string }[],
): Promise<UpdatePeriodMatchupsResult> {
  const { userId } = await auth.protect();
  try {
    await updatePeriodMatchups({ leagueId, periodId, pairs, callerUserId: userId });
    revalidatePath(`/leagues/${leagueId}/schedule`);
    revalidatePath(`/leagues/${leagueId}/scoreboard`);
    revalidatePath(`/leagues/${leagueId}/standings`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
