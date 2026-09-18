"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { resetDraft } from "@/lib/draft/reset";
import { getLeague } from "@/lib/leagues/mutations";

/** Returns { ok, error } rather than throwing — same convention as the LM
 * Roster Moves actions — so the confirm form can show the refusal inline
 * (wrong league name, wrong status, non-commissioner) instead of crashing
 * the Server Action boundary. The typed confirmation is checked here,
 * server-side, against the real league name — never trust a client-supplied
 * expected value for a mutation this destructive. */
export async function resetDraftAction(
  leagueId: string,
  draftId: string,
  confirmName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId } = await auth.protect();

  const league = await getLeague(leagueId);
  if (!league) return { ok: false, error: "League not found." };
  if (confirmName !== league.name) {
    return { ok: false, error: `Type the league's exact name ("${league.name}") to confirm.` };
  }

  try {
    await resetDraft({ draftId, callerUserId: userId });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reset draft." };
  }

  revalidatePath(`/leagues/${leagueId}/settings/reset-draft`);
  revalidatePath(`/leagues/${leagueId}/settings/draft-settings`);
  revalidatePath(`/leagues/${leagueId}/settings`);
  revalidatePath(`/leagues/${leagueId}/draft`);
  revalidatePath(`/leagues/${leagueId}/draft/recap`);
  return { ok: true };
}
