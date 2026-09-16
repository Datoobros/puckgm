// One-off reset (plans/team-page-batch.md Task 3b, run exactly once after the
// free-agency gate shipped): clears every roster in the user's real
// "Experimenting" league so they can run a proper startup draft through it,
// now that free agency won't let anyone instant-add around the draft.
//
// Scoped to this league by EXACT name AND id — aborts otherwise, since this
// DB is shared between local dev and production (PROGRESS.md). Re-running
// after a successful reset is a safe no-op: there's nothing left to cancel/
// clear/delete/close the second time (all these are idempotent operations
// over an already-empty set). Also deletes the stale "Roster Action Test
// League (delete me)" artifact (0 players) — leaves "QTest League"/"QTest 2"
// alone, per the plan.
//
// Usage:
//   npx tsx scripts/reset-experimenting-for-draft.ts --dry-run   # prints what it would do, writes nothing
//   npx tsx scripts/reset-experimenting-for-draft.ts             # does it for real

import { prisma } from "@/lib/db";
import { cancelTrade } from "@/lib/trades/mutations";
import { deleteLeague } from "@/lib/leagues/mutations";

const LEAGUE_NAME = "Experimenting";
const LEAGUE_ID = "cmts0s1uu0000lc0405mux8c5";
const STALE_LEAGUE_NAME = "Roster Action Test League (delete me)";
const STALE_LEAGUE_ID = "cmtrz8zlv0000ru2ssnftw9vk";

const DRY_RUN = process.argv.includes("--dry-run");

async function snapshot(leagueId: string, label: string) {
  const [openSlots, pendingTrades, pendingWaivers, pendingBids, lineupCount] = await Promise.all([
    prisma.rosterSlot.count({ where: { team: { leagueId }, effectiveTo: null } }),
    prisma.trade.count({ where: { leagueId, state: { in: ["PROPOSED", "UNDER_REVIEW"] } } }),
    prisma.waiverClaim.count({ where: { team: { leagueId }, result: "PENDING" } }),
    prisma.faBid.count({ where: { team: { leagueId }, result: "PENDING" } }),
    prisma.lineupEntry.count({ where: { team: { leagueId } } }),
  ]);
  console.log(`${label}:`);
  console.log(`  open roster slots:            ${openSlots}`);
  console.log(`  trades PROPOSED/UNDER_REVIEW: ${pendingTrades}`);
  console.log(`  waiver claims PENDING:        ${pendingWaivers}`);
  console.log(`  FA bids PENDING:              ${pendingBids}`);
  console.log(`  lineup entries:               ${lineupCount}`);
}

async function main() {
  const league = await prisma.league.findUnique({ where: { id: LEAGUE_ID }, include: { teams: true } });
  if (!league || league.name !== LEAGUE_NAME) {
    throw new Error(
      `Refusing to run — expected league id "${LEAGUE_ID}" named "${LEAGUE_NAME}", found: ` +
        (league ? `id "${league.id}" named "${league.name}".` : "no league with that id at all."),
    );
  }
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Target: "${league.name}" (${league.id}), teams: ${league.teams.map((t) => t.name).join(", ")}\n`);

  await snapshot(league.id, "BEFORE");

  const pendingTrades = await prisma.trade.findMany({
    where: { leagueId: league.id, state: { in: ["PROPOSED", "UNDER_REVIEW"] } },
    include: { items: true, proposedByTeam: true },
  });
  const pendingWaivers = await prisma.waiverClaim.findMany({
    where: { team: { leagueId: league.id }, result: "PENDING" },
    include: { team: true, player: true },
  });
  const pendingBids = await prisma.faBid.findMany({
    where: { team: { leagueId: league.id }, result: "PENDING" },
    include: { team: true, player: true },
  });
  const openSlots = await prisma.rosterSlot.findMany({
    where: { team: { leagueId: league.id }, effectiveTo: null },
    include: { team: true, player: true },
    orderBy: [{ team: { name: "asc" } }, { slotType: "asc" }],
  });
  const lineupByTeam = await prisma.lineupEntry.groupBy({
    by: ["teamId"],
    where: { team: { leagueId: league.id } },
    _count: { _all: true },
  });

  const nothingToReset =
    pendingTrades.length === 0 && pendingWaivers.length === 0 && pendingBids.length === 0 && openSlots.length === 0 && lineupByTeam.length === 0;

  console.log("\nWould change:" + (DRY_RUN ? "" : " (applying now)"));
  console.log(`  ${pendingTrades.length} trade(s) -> CANCELLED:`);
  for (const t of pendingTrades) {
    console.log(`    ${t.id}  state=${t.state}  proposedBy=${t.proposedByTeam.name}  items=${t.items.length}`);
  }
  console.log(`  ${pendingWaivers.length} waiver claim(s) -> CLEARED:`);
  for (const c of pendingWaivers) {
    console.log(`    ${c.id}  team=${c.team.name}  player=${c.player.fullName}`);
  }
  console.log(`  ${pendingBids.length} FA bid(s) -> LOST:`);
  for (const b of pendingBids) {
    console.log(`    ${b.id}  team=${b.team.name}  player=${b.player.fullName}  amount=${b.amount}`);
  }
  console.log(`  ${lineupByTeam.reduce((s, g) => s + g._count._all, 0)} lineup entries -> deleted, by team:`);
  for (const g of lineupByTeam) {
    const team = league.teams.find((t) => t.id === g.teamId);
    console.log(`    ${team?.name ?? g.teamId}: ${g._count._all}`);
  }
  console.log(`  ${openSlots.length} roster slot(s) -> closed (effectiveTo = now):`);
  for (const s of openSlots) {
    console.log(`    ${s.team.name}: ${s.player.fullName} (${s.slotType})`);
  }
  console.log(
    nothingToReset
      ? "  0 TransactionLog COMMISSIONER_RESET rows -> nothing changed above, so none will be written"
      : `  ${league.teams.length} TransactionLog COMMISSIONER_RESET row(s) -> one per team`,
  );

  const stale = await prisma.league.findUnique({ where: { id: STALE_LEAGUE_ID } });
  if (stale && stale.name === STALE_LEAGUE_NAME) {
    const staleTeams = await prisma.team.count({ where: { leagueId: stale.id } });
    console.log(`\nAlso would delete stale test league "${stale.name}" (${stale.id}), ${staleTeams} team(s).`);
  } else {
    console.log(`\nStale test league "${STALE_LEAGUE_NAME}" (${STALE_LEAGUE_ID}) not found by exact id+name — would skip.`);
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Nothing was written.");
    return;
  }

  const commissionerUserId = league.commissionerUserId ?? league.teams[0]?.managerUserId;
  if (!commissionerUserId) throw new Error("Couldn't resolve a caller for this league — no commissionerUserId and no teams.");

  if (nothingToReset) {
    // Already reset (or never had anything to reset) — skip even the
    // TransactionLog write, so re-running this script is a genuine no-op,
    // not just a no-op on roster state that still logs a duplicate
    // "COMMISSIONER_RESET" activity-feed entry every time it's run.
    console.log("\nNothing to reset — every count above was already 0. Skipping the roster-wipe steps (still checking the stale test league below).");
  } else {
    for (const trade of pendingTrades) {
      await cancelTrade({ tradeId: trade.id, callerUserId: commissionerUserId, allowUnderReview: true });
    }
    await prisma.waiverClaim.updateMany({ where: { team: { leagueId: league.id }, result: "PENDING" }, data: { result: "CLEARED" } });
    await prisma.faBid.updateMany({ where: { team: { leagueId: league.id }, result: "PENDING" }, data: { result: "LOST" } });
    await prisma.lineupEntry.deleteMany({ where: { team: { leagueId: league.id } } });

    const now = new Date();
    await prisma.rosterSlot.updateMany({ where: { team: { leagueId: league.id }, effectiveTo: null }, data: { effectiveTo: now } });

    await prisma.transactionLog.createMany({
      data: league.teams.map((t) => ({
        leagueId: league.id,
        type: "COMMISSIONER_RESET",
        actorTeamId: t.id,
        payload: { reason: "pre-draft roster reset" },
      })),
    });

    console.log("\nApplied. Re-checking...");
    await snapshot(league.id, "AFTER");
  }

  if (stale && stale.name === STALE_LEAGUE_NAME) {
    const firstTeam = await prisma.team.findFirst({ where: { leagueId: stale.id }, orderBy: { createdAt: "asc" } });
    await deleteLeague(stale.id, stale.commissionerUserId ?? firstTeam?.managerUserId ?? commissionerUserId);
    console.log(`\nDeleted stale test league "${stale.name}" (${stale.id}).`);
  } else {
    console.log(`\nStale test league not found by exact id+name at delete time — skipped.`);
  }

  const totalLeagues = await prisma.league.count();
  console.log(`\nTotal leagues remaining: ${totalLeagues}`);
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
