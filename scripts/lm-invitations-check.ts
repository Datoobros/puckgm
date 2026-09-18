// Regression check for LM Tools batch Task 7 — email invitations +
// assign-by-picker. Deliberately never reaches Clerk's createInvitation:
// every validation-path assertion below fails before that call (bad email
// format, non-commissioner caller, or team-not-in-league — all checked
// earlier in inviteManagerByEmail/inviteToLeagueByEmail than the Clerk
// call), and the already-has-account path takes the setTeamManager branch
// instead of emailing anyone. No real invitation email is ever sent by this
// script — see PROGRESS.md/the plan for why that's a hard rule here.

// clerkClient() (invitations.ts, directory.ts) reads CLERK_SECRET_KEY straight
// off process.env — unlike Prisma, which loads .env itself internally, so a
// bare `tsx` run never sees it otherwise. Load it the same way `next dev`/
// `next build` do, before anything below can call clerkClient().
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { inviteManagerByEmail, inviteToLeagueByEmail } from "@/lib/leagues/invitations";
import { findUserByEmail } from "@/lib/users/directory";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

const ORIGIN = "https://lm-invitations-check.test";
const ROSTER_COMPOSITION = { positionMode: "SEPARATE" as const, C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 };

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "LM Invitations Test League (delete me)",
    season: 2031,
    managerUserId: "lminv-commissioner",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: ROSTER_COMPOSITION,
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lminv-teamB-manager", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  console.log("\n-- validation: bad email --");
  await rejects(
    () => inviteManagerByEmail({ leagueId, teamId: teamA, email: "not-an-email", origin: ORIGIN, callerUserId: "lminv-commissioner" }),
    "inviteManagerByEmail rejects a malformed email",
  );
  await rejects(
    () => inviteToLeagueByEmail({ leagueId, email: "not-an-email", origin: ORIGIN, callerUserId: "lminv-commissioner" }),
    "inviteToLeagueByEmail rejects a malformed email",
  );

  console.log("\n-- validation: non-commissioner caller --");
  await rejects(
    () => inviteManagerByEmail({ leagueId, teamId: teamA, email: "someone@example.com", origin: ORIGIN, callerUserId: "lminv-teamB-manager" }),
    "inviteManagerByEmail rejects a non-commissioner caller",
  );
  await rejects(
    () => inviteToLeagueByEmail({ leagueId, email: "someone@example.com", origin: ORIGIN, callerUserId: "lminv-teamB-manager" }),
    "inviteToLeagueByEmail rejects a non-commissioner caller",
  );

  console.log("\n-- validation: team not in league --");
  const { leagueId: otherLeagueId, teamId: otherTeam } = await createLeague({
    name: "LM Invitations Test League B (delete me)",
    season: 2031,
    managerUserId: "lminv-other-commissioner",
    teamName: "Other Team",
    leagueType: "DYNASTY",
    rosterComposition: ROSTER_COMPOSITION,
    farmSlots: 6,
    irSlots: 2,
  });
  await rejects(
    () => inviteManagerByEmail({ leagueId, teamId: otherTeam, email: "someone@example.com", origin: ORIGIN, callerUserId: "lminv-commissioner" }),
    "inviteManagerByEmail rejects a team that belongs to a different league",
  );

  console.log("\n-- already-has-account branch --");
  const secondEmail = process.env.TEST_SECOND_USER_EMAIL;
  if (!secondEmail) {
    console.log(
      "  SKIPPED: set TEST_SECOND_USER_EMAIL to a real second Clerk account's email (not the one running this session) to cover the already-has-account branch.",
    );
  } else {
    const found = await findUserByEmail(secondEmail);
    assert(!!found, `findUserByEmail resolves TEST_SECOND_USER_EMAIL (${secondEmail}) to a real Clerk user`);
    if (found) {
      const result = await inviteManagerByEmail({
        leagueId,
        teamId: teamA,
        email: secondEmail,
        origin: ORIGIN,
        callerUserId: "lminv-commissioner",
      });
      assert(result.assigned === true, "inviteManagerByEmail assigns directly instead of emailing when the address already has an account");
      const teamAfter = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
      assert(teamAfter.managerUserId === found.id, "the team's manager is now the existing Clerk user");
      assert(teamAfter.invitedEmail === null, "invitedEmail stays clear on the direct-assign path");
    }
  }

  console.log("\n-- cleanup --");
  await deleteLeague(otherLeagueId, "lminv-other-commissioner");
  await deleteLeague(leagueId, "lminv-commissioner");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
