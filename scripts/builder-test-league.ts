// One-off seed/cleanup script for verifying Task 2 of plans/trades-batch.md
// (trades page split + ESPN-style builder + confirm modal + redirect) in a
// real browser. Creates a disposable 3-team league — NOT the user's real
// "Experimenting" league — rostered entirely with real Player rows already
// in the DB (no synthetic fixtures needed for this task, unlike some other
// test scripts). Named distinctly and cleaned up by exact name, per
// PROGRESS.md's shared-database convention.
//
// Usage:
//   npx tsx scripts/builder-test-league.ts            # seed
//   npx tsx scripts/builder-test-league.ts --cleanup   # delete by exact name

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { commissionerAddPlayer } from "@/lib/rosters/mutations";
import { proposeTrade, respondToTrade } from "@/lib/trades/mutations";

const LEAGUE_NAME = "Builder Test League (delete me)";
const LEAGUE_SEASON = 2027;

const USER_A = "builder-test-A"; // Alpha — commissioner, only needed to lock a Charlie player via a side trade
const USER_B = "builder-test-B"; // Bravo — the manager driving the actual builder verification
const USER_C = "builder-test-C"; // Charlie — Bravo's counterparty; also lends a player to Alpha to demonstrate a locked row

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
    teamName: "Alpha",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 1, BENCH: 3 },
    farmSlots: 4,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: USER_B, teamName: "Bravo" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: USER_C, teamName: "Charlie" });

  // Real players already in the DB — no synthetic Player fixtures needed.
  const [crosby, burns, malkin, ovechkin, kane, doughty, hellebuyck, tavares, marchand, giroux, letang, bobrovsky] =
    await Promise.all(
      [
        "Sidney Crosby",
        "Brent Burns",
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
      ].map(findPlayer),
    );

  for (const p of [crosby, burns]) {
    await commissionerAddPlayer({ leagueId, teamId: teamA, playerId: p.id, callerUserId: USER_A });
  }
  for (const p of [malkin, ovechkin, kane, doughty, hellebuyck]) {
    await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: p.id, callerUserId: USER_A });
  }
  for (const p of [tavares, marchand, giroux, letang, bobrovsky]) {
    await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: p.id, callerUserId: USER_A });
  }

  // Alpha <-> Charlie: propose then accept, so this trade is UNDER_REVIEW —
  // Letang (Charlie's) and Crosby (Alpha's) both become "locked in a pending
  // trade" league-wide. Bravo (the manager actually exercising the builder)
  // will see Letang's row disabled with the "Pending trade" badge when
  // building a trade against Charlie's roster — the plan's locked-player
  // verification step, no extra setup required.
  const { tradeId: lockTradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamC,
    managerUserId: USER_A,
    give: { playerIds: [crosby.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [letang.id], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: lockTradeId, managerUserId: USER_C, accept: true });

  console.log("seeded league:", leagueId);
  console.log("teamA (Alpha, manager", USER_A, "):", teamA);
  console.log("teamB (Bravo, manager", USER_B, "):", teamB, "<- use this to drive the builder verification");
  console.log("teamC (Charlie, manager", USER_C, "):", teamC);
  console.log("lockTradeId (Alpha<->Charlie, UNDER_REVIEW):", lockTradeId);
  console.log("Letang (playerId", letang.id, ") should show 'Pending trade' and a disabled checkbox on Charlie's roster.");
  console.log("\nBrowser check URLs (with a matching // TEMP: userId bypass):");
  console.log(`  /leagues/${leagueId}/trades                (userId = ${USER_B})`);
  console.log(`  /leagues/${leagueId}/trades/new?with=${teamC}   (userId = ${USER_B})`);
  console.log(`  /leagues/${leagueId}/trades                (userId = ${USER_C}) — after Bravo sends`);
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
