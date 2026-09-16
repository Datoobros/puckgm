// Disposable seed/cleanup script for verifying Task 3 of plans/trades-batch.md
// (roster-fit UX + locked-player UI, issues #4/#5's UI half) in a real
// browser. NOT the user's real "Experimenting" league — copied and adapted
// from scripts/builder-test-league.ts (Task 2) rather than reused as-is, so
// each script's --cleanup only ever touches its own league by exact name.
//
// Usage:
//   npx tsx scripts/fit-ux-test-league.ts            # seed
//   npx tsx scripts/fit-ux-test-league.ts --cleanup   # delete by exact name

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { commissionerAddPlayer } from "@/lib/rosters/mutations";
import { proposeTrade } from "@/lib/trades/mutations";

const LEAGUE_NAME = "Fit UX Test League (delete me)";
const LEAGUE_SEASON = 2027;

const USER_A = "fitux-test-A"; // Alpha — commissioner only, no roster needed
const USER_B = "fitux-test-B"; // Bravo — drives the proposer-side (send) flow
const USER_C = "fitux-test-C"; // Charlie — drives the acceptor-side (accept) flow

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

  // Small active cap (6, plus 1 farm/1 IR) so a 2-player overflow is trivial
  // to hit. A bench slot is deliberately kept (not zeroed out) so the final
  // "Move still works on a trade-locked player" check always has a
  // destination to move into.
  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: LEAGUE_SEASON,
    managerUserId: USER_A,
    teamName: "Alpha",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 0, BENCH: 1 },
    farmSlots: 1,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: USER_B, teamName: "Bravo" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: USER_C, teamName: "Charlie" });

  // Same 12 real players already used (and confirmed present in the DB) by
  // scripts/builder-test-league.ts (Task 2) — reused here with a different
  // split: 6 a side, both exactly at the 6-slot active cap.
  const [crosby, malkin, ovechkin, kane, doughty, hellebuyck, tavares, marchand, giroux, letang, bobrovsky, burns] =
    await Promise.all(
      [
        "Sidney Crosby",
        "Evgeni Malkin",
        "Alex Ovechkin",
        "Patrick Kane",
        "Drew Doughty",
        "Connor Hellebuyck",
        "John Tavares",
        "Brad Marchand",
        "Claude Giroux",
        "Kris Letang",
        "Sergei Bobrovsky",
        "Brent Burns",
      ].map(findPlayer),
    );

  // Bravo — Crosby/Malkin are the two dropped live in the browser during
  // the proposer-overflow flow; Doughty/Hellebuyck are held in reserve as
  // trade B's give-away pair (below), so the two flows never touch the same
  // player.
  for (const p of [crosby, malkin, ovechkin, kane, doughty, hellebuyck]) {
    await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: p.id, callerUserId: USER_A });
  }
  // Charlie — also at cap, so accepting anything without first dropping
  // overflows.
  for (const p of [tavares, marchand, giroux, letang, bobrovsky, burns]) {
    await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: p.id, callerUserId: USER_A });
  }

  // Trade B, pre-seeded PROPOSED (not accepted) — Bravo gives Doughty +
  // Hellebuyck to Charlie for nothing. Bravo giving players away never
  // overflows Bravo, so this proposes cleanly through proposeTrade's normal
  // propose-side check; Charlie is already at cap, so accepting it needs
  // the accept-side overflow flow (Task 3's other half) — driven live in
  // the browser from the review page, not pre-baked here.
  const { tradeId: tradeB } = await proposeTrade({
    leagueId,
    proposingTeamId: teamB,
    counterpartyTeamId: teamC,
    managerUserId: USER_B,
    give: { playerIds: [doughty.id, hellebuyck.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });

  console.log("seeded league:", leagueId);
  console.log("teamA (Alpha, commissioner", USER_A, "):", teamA);
  console.log("teamB (Bravo, manager", USER_B, "):", teamB, "<- proposer-overflow flow (drop Crosby + Malkin live)");
  console.log("teamC (Charlie, manager", USER_C, "):", teamC, "<- acceptor-overflow flow (review tradeB, then drop 2 live)");
  console.log("tradeB (Bravo -> Charlie, Doughty+Hellebuyck, PROPOSED):", tradeB);
  console.log("\nBrowser check URLs (with a matching // TEMP: userId bypass):");
  console.log(`  /leagues/${leagueId}/trades/new?with=${teamC}   (userId = ${USER_B})`);
  console.log(`  /leagues/${leagueId}/teams/${teamB}             (userId = ${USER_B})`);
  console.log(`  /leagues/${leagueId}/trades/${tradeB}/review    (userId = ${USER_C})`);
  console.log(`  /leagues/${leagueId}/teams/${teamC}             (userId = ${USER_C})`);
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
