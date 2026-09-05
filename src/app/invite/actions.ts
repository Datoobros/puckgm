"use server";

import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeagueByInviteCode, createTeam, claimTeam } from "@/lib/leagues/mutations";

export async function joinLeagueAction(inviteCode: string, formData: FormData) {
  const { userId } = await auth.protect();

  const league = await getLeagueByInviteCode(inviteCode);
  if (!league) throw new Error("This invite link is invalid or has been revoked.");

  const teamName = String(formData.get("teamName") ?? "").trim();
  if (!teamName) throw new Error("Team name is required.");

  await createTeam({ leagueId: league.id, managerUserId: userId, teamName });
  redirect(`/leagues/${league.id}`);
}

export async function claimTeamAction(claimCode: string) {
  const { userId } = await auth.protect();
  const { leagueId } = await claimTeam({ claimCode, newManagerUserId: userId });
  redirect(`/leagues/${leagueId}`);
}
