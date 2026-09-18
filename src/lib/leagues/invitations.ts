// Email invitations via Clerk (LM Tools Task 7) — no separate email
// provider. A per-team invite (inviteManagerByEmail) assigns the team
// directly if the address already has a Clerk account; otherwise it sends a
// real invitation email and stashes the address on the team so the Managers
// table can show it's pending. A league-wide invite (inviteToLeagueByEmail)
// has no team to mark — it just reuses the existing shareable invite code as
// the email's redirect target.

import { clerkClient } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { isLeagueCommissioner, regenerateTeamClaimCode, regenerateInviteCode, setTeamManager } from "@/lib/leagues/mutations";
import { findUserByEmail } from "@/lib/users/directory";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) throw new Error("Enter a valid email address.");
  return trimmed;
}

export async function inviteManagerByEmail(input: {
  leagueId: string;
  teamId: string;
  email: string;
  origin: string;
  callerUserId: string;
}): Promise<{ assigned: boolean }> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can send invitations.");
  }
  const email = normalizeEmail(input.email);
  const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new Error("Team not found in this league.");

  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    await setTeamManager({ leagueId: input.leagueId, teamId: input.teamId, callerUserId: input.callerUserId, newManagerUserId: existingUser.id });
    await prisma.team.update({ where: { id: input.teamId }, data: { invitedEmail: null } });
    return { assigned: true };
  }

  const claimCode = team.claimCode ?? (await regenerateTeamClaimCode({ leagueId: input.leagueId, teamId: input.teamId, callerUserId: input.callerUserId })).claimCode;
  const client = await clerkClient();
  await client.invitations.createInvitation({
    emailAddress: email,
    redirectUrl: `${input.origin}/invite/team/${claimCode}`,
    ignoreExisting: true,
  });
  await prisma.team.update({ where: { id: input.teamId }, data: { invitedEmail: email } });
  return { assigned: false };
}

export async function inviteToLeagueByEmail(input: { leagueId: string; email: string; origin: string; callerUserId: string }): Promise<void> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can send invitations.");
  }
  const email = normalizeEmail(input.email);
  const league = await prisma.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  const inviteCode = league.inviteCode ?? (await regenerateInviteCode(input.leagueId, input.callerUserId)).inviteCode;

  const client = await clerkClient();
  await client.invitations.createInvitation({
    emailAddress: email,
    redirectUrl: `${input.origin}/invite/${inviteCode}`,
    ignoreExisting: true,
  });
}
