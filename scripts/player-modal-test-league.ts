// Disposable seed/cleanup script for verifying Task 4 of
// plans/player-modal-batch.md (the player-profile modal's action card) in a
// real browser. NOT the user's real "Experimenting" league — pattern copied
// from scripts/header-modal-test-league.ts / scripts/fit-ux-test-league.ts.
//
// Team A has a small active cap (6: C/LW/RW/D/G/BENCH) so "fill to cap, then
// ADD one more" (flow 3's roster-full picker) is quick to drive by hand.
// Team B carries a >=80-career-GP veteran sent to the farm (waiver-exposed,
// for flow 4's CLAIM) and a second player that stays on Team B's active
// roster (for flow 5's PROPOSE TRADE). FAAB toggling (flow 6) and the draft
// reset that closes free agency (flow 7) are commissioner actions done live
// in the browser (LM Tools), not pre-seeded.
//
// Usage:
//   npx tsx scripts/player-modal-test-league.ts            # seed
//   npx tsx scripts/player-modal-test-league.ts --cleanup   # delete by exact name

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { addPlayerToRoster, sendToFarm } from "@/lib/rosters/mutations";
import { setUpDraft } from "@/lib/draft/mutations";

const LEAGUE_NAME = "Player Modal Actions (delete me)";
const LEAGUE_SEASON = 2027;

const USER_A = "pma-test-A"; // drives every flow in the verification section
const USER_B = "pma-test-B"; // owns the waiver-exposed veteran + the trade target

async function cleanup() {
  const league = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (!league) {
    console.log("nothing to clean up — no league named", JSON.stringify(LEAGUE_NAME));
    return;
  }
  await deleteLeague(league.id, league.commissionerUserId ?? USER_A);
  console.log("deleted league:", LEAGUE_NAME, league.id);
}

async function findPlayer(fullName: string) {
  const p = await prisma.player.findFirst({ where: { fullName } });
  if (!p) throw new Error(`Fixture player not found in DB: ${fullName} — adjust the script's player list.`);
  return p;
}

async function seed() {
  const existing = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (existing) {
    console.log("already seeded — league:", existing.id, "(run with --cleanup first to reseed)");
    return;
  }

  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: LEAGUE_SEASON,
    managerUserId: USER_A,
    teamName: "Modal Actions A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 0, BENCH: 1 },
    farmSlots: 2,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: USER_B, teamName: "Modal Actions B" });

  // Throwaway 1-round STARTUP draft, marked COMPLETE directly rather than
  // run through startDraft/autodraftBatch — same reasoning as
  // scripts/player-profile-check.ts: autodraft would grab real stars off
  // the live player pool, which this script needs to stay unowned.
  const { draftId } = await setUpDraft({
    leagueId,
    season: 2021,
    type: "STARTUP",
    roundCount: 1,
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB],
    pickTimerSeconds: 600,
    callerUserId: USER_A,
  });
  await prisma.draft.update({ where: { id: draftId }, data: { status: "COMPLETE", currentPickDeadline: null } });

  // Team B: a >=80-career-GP veteran, sent to the farm so he's waiver-exposed
  // (flow 4's CLAIM target for Team A), plus a second player left on Team
  // B's active roster (flow 5's PROPOSE TRADE target).
  const [giroux, letang] = await Promise.all([findPlayer("Claude Giroux"), findPlayer("Kris Letang")]);
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: giroux.id, managerUserId: USER_B });
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: letang.id, managerUserId: USER_B });
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamB, playerId: giroux.id, managerUserId: USER_B });
  if (!waiverExposed) throw new Error("Expected Claude Giroux (career veteran) to be waiver-exposed on demotion.");

  // Free agents left unrostered for the browser flows:
  //   - flow 1 (ADD) / flow 2 (DROP): Sidney Crosby — added then dropped
  //     live, so he's free again for flow 6 (BID, once FAAB is turned on)
  //     and flow 7 (free-agency-closed note, once the draft is reset).
  //   - flow 3 (fill Team A's 6-slot active cap, then ADD a 7th to trigger
  //     the roster-full picker): Evgeni Malkin (C), Alex Ovechkin (LW),
  //     Patrick Kane (RW), Drew Doughty (D), Connor Hellebuyck (G), John
  //     Tavares (C, falls to BENCH) fill the cap; Brad Marchand is the 7th.
  // All 12 names are the same set scripts/fit-ux-test-league.ts already
  // confirmed present in the DB.
  const fixtureNames = [
    "Sidney Crosby",
    "Evgeni Malkin",
    "Alex Ovechkin",
    "Patrick Kane",
    "Drew Doughty",
    "Connor Hellebuyck",
    "John Tavares",
    "Brad Marchand",
  ];
  await Promise.all(fixtureNames.map(findPlayer));

  console.log("seeded league:", leagueId);
  console.log("teamA (Modal Actions A, manager", USER_A, "):", teamA);
  console.log("teamB (Modal Actions B, manager", USER_B, "):", teamB);
  console.log("Giroux (waiver-exposed, on Team B's farm):", giroux.id);
  console.log("Letang (Team B active — PROPOSE TRADE target):", letang.id);
  console.log("Free agents ready: Crosby (flows 1/2/6/7), Malkin/Ovechkin/Kane/Doughty/Hellebuyck/Tavares (flow 3 fill), Marchand (flow 3 overflow)");
  console.log("\nBrowser check URL (with a matching // TEMP: userId bypass):");
  console.log(`  /leagues/${leagueId}/players   (userId = ${USER_A})`);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
  } else {
    await seed();
  }
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
