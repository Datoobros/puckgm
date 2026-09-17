// Regression check for LM Tools batch Task 6 — named divisions.

import { prisma } from "@/lib/db";
import {
  createLeague,
  createTeam,
  deleteLeague,
  getLeagueDivisions,
  setLeagueDivisions,
  renameLeagueDivision,
  setTeamDivision,
} from "@/lib/leagues/mutations";

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

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "LM Divisions Test League (delete me)",
    season: 2031,
    managerUserId: "lmdiv-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lmdiv-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  console.log("\n-- add two divisions --");
  assert((await getLeagueDivisions(leagueId)).length === 0, "a fresh league has no divisions");
  await setLeagueDivisions({ leagueId, callerUserId: "lmdiv-A", divisions: ["East", "West"] });
  assert(JSON.stringify(await getLeagueDivisions(leagueId)) === JSON.stringify(["East", "West"]), "both divisions were added");

  console.log("\n-- assign, and assigning a nonexistent name is rejected --");
  await setTeamDivision({ leagueId, teamId: teamA, callerUserId: "lmdiv-A", division: "East" });
  const teamAAfter = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(teamAAfter.division === "East", "Team A assigned to East");
  await rejects(
    () => setTeamDivision({ leagueId, teamId: teamB, callerUserId: "lmdiv-A", division: "North" }),
    "assigning a division that doesn't exist on the league is rejected",
  );

  console.log("\n-- rename a division: teams follow --");
  await renameLeagueDivision({ leagueId, callerUserId: "lmdiv-A", from: "East", to: "Atlantic" });
  const divisionsAfterRename = await getLeagueDivisions(leagueId);
  assert(JSON.stringify(divisionsAfterRename) === JSON.stringify(["Atlantic", "West"]), "the division list itself renamed in place");
  const teamAAfterRename = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(teamAAfterRename.division === "Atlantic", "Team A's own division followed the rename");

  console.log("\n-- renaming to an existing name, or a name that isn't a real division, is rejected --");
  await rejects(
    () => renameLeagueDivision({ leagueId, callerUserId: "lmdiv-A", from: "West", to: "Atlantic" }),
    "renaming onto an already-existing division name is rejected",
  );
  await rejects(
    () => renameLeagueDivision({ leagueId, callerUserId: "lmdiv-A", from: "North", to: "South" }),
    "renaming a division that doesn't exist is rejected",
  );

  console.log("\n-- remove a division: its teams are cleared --");
  await setTeamDivision({ leagueId, teamId: teamB, callerUserId: "lmdiv-A", division: "West" });
  await setLeagueDivisions({ leagueId, callerUserId: "lmdiv-A", divisions: ["Atlantic"] });
  const divisionsAfterRemove = await getLeagueDivisions(leagueId);
  assert(JSON.stringify(divisionsAfterRemove) === JSON.stringify(["Atlantic"]), "West was removed from the division list");
  const teamBAfterRemove = await prisma.team.findUniqueOrThrow({ where: { id: teamB } });
  assert(teamBAfterRemove.division === null, "Team B's division (West, now removed) was cleared to null");
  const teamAStillAssigned = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(teamAStillAssigned.division === "Atlantic", "Team A, still in a division that survived, is untouched");

  console.log("\n-- duplicate names in one submission are rejected --");
  await rejects(
    () => setLeagueDivisions({ leagueId, callerUserId: "lmdiv-A", divisions: ["Atlantic", "Atlantic", "Pacific"] }),
    "submitting a duplicate division name is rejected",
  );

  console.log("\n-- refused for a non-commissioner caller --");
  await rejects(
    () => setLeagueDivisions({ leagueId, callerUserId: "lmdiv-B", divisions: ["Atlantic", "Pacific"] }),
    "setLeagueDivisions refused for a non-commissioner caller",
  );
  await rejects(
    () => renameLeagueDivision({ leagueId, callerUserId: "lmdiv-B", from: "Atlantic", to: "Metro" }),
    "renameLeagueDivision refused for a non-commissioner caller",
  );

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lmdiv-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
