// Regression check for the Move UI's new mutation layer: swapLineupSlots
// (src/lib/lineups/mutations.ts), placeOnIrClearingLineup/
// activateFromIrIntoSlot (src/lib/rosters/mutations.ts), and the
// stale-LineupEntry capacity-check fix bundled into the same rewrite
// (occupancy counts now exclude players no longer on the ACTIVE roster).
//
// Uses a far-future date with no published NHL schedule yet, so every
// player is guaranteed unlocked — lock-rejection itself is already exercised
// by the pre-existing setLineupSlot tests this reuses via
// loadAndValidateLineupMove.

import { prisma } from "@/lib/db";
import { createLeague } from "@/lib/leagues/mutations";
import { sendToFarm, placeOnIrClearingLineup, activateFromIrIntoSlot } from "@/lib/rosters/mutations";
import { setLineupSlot, swapLineupSlots, getLineupForDate } from "@/lib/lineups/mutations";

const DATE = "2031-02-10";
const MANAGER = "move-feature-test-1";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`ok: ${msg}`);
}

async function main() {
  console.log("-- setup: league with a full but not tiny lineup --");
  const { leagueId, teamId } = await createLeague({
    name: "Move Feature Test League (delete me)",
    season: 2031,
    managerUserId: MANAGER,
    teamName: "Move Test Team",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 0, F: 0, D: 2, G: 0, UTIL: 1, BENCH: 2 },
    farmSlots: 6,
    irSlots: 3,
  });
  console.log("league:", leagueId, "team:", teamId);

  const centers = await prisma.player.findMany({ where: { primaryPosition: "C" }, take: 8 });
  const wingers = await prisma.player.findMany({ where: { primaryPosition: "L" }, take: 1 });
  const dmen = await prisma.player.findMany({ where: { primaryPosition: "D" }, take: 2 });
  assert(centers.length >= 8, "found at least 8 real C players to use as fixtures");
  assert(wingers.length >= 1, "found at least 1 real L player");
  assert(dmen.length >= 2, "found at least 2 real D players");

  const [p1, p5, p6, p7, p8, filler] = centers;
  const [p2] = wingers;
  const [p3, p4] = dmen;

  // Remember real officialRosterStatus so this shared-DB script restores it
  // exactly, rather than leaving fixture players permanently marked IR.
  const originalStatus = new Map<string, string | null>();
  for (const p of [p2, p7, p8]) originalStatus.set(p.id, p.officialRosterStatus);

  async function setIr(playerId: string) {
    await prisma.player.update({ where: { id: playerId }, data: { officialRosterStatus: "IR" } });
  }
  async function clearIr(playerId: string) {
    await prisma.player.update({ where: { id: playerId }, data: { officialRosterStatus: null } });
  }

  try {
    // p1,p2,p3,p4,p5,p6 start ACTIVE; p7,p8 start on IR (real IR status).
    for (const p of [p1, p2, p3, p4, p5, p6]) {
      await prisma.rosterSlot.create({ data: { teamId, playerId: p.id, slotType: "ACTIVE" } });
    }
    for (const p of [p7, p8]) {
      await prisma.rosterSlot.create({ data: { teamId, playerId: p.id, slotType: "IR" } });
      await setIr(p.id);
    }

    await setLineupSlot({ leagueId, teamId, playerId: p1.id, date: DATE, slot: "C", managerUserId: MANAGER });
    await setLineupSlot({ leagueId, teamId, playerId: p2.id, date: DATE, slot: "L", managerUserId: MANAGER });
    await setLineupSlot({ leagueId, teamId, playerId: p3.id, date: DATE, slot: "D", managerUserId: MANAGER });
    await setLineupSlot({ leagueId, teamId, playerId: p4.id, date: DATE, slot: "D", managerUserId: MANAGER });
    await setLineupSlot({ leagueId, teamId, playerId: p5.id, date: DATE, slot: "UTIL", managerUserId: MANAGER });
    // p6 stays unset -> defaults to Bench.
    console.log("setup complete: p1=C p2=L p3=D p4=D p5=UTIL p6=BE(implicit), p7/p8 on IR");

    console.log("\n-- TEST A: swapLineupSlots — bench player swaps into a full C slot --");
    await swapLineupSlots({
      leagueId,
      teamId,
      date: DATE,
      managerUserId: MANAGER,
      moverId: p6.id,
      moverDestinationSlot: "C",
      displacedPlayerId: p1.id,
      displacedDestinationSlot: "BE", // p6's own origin slot
    });
    const afterA = await getLineupForDate(teamId, DATE);
    const slotOf = (m: typeof afterA, playerId: string) => m.find((e) => e.playerId === playerId)?.lineupSlot ?? "BE";
    assert(slotOf(afterA, p6.id) === "C", "mover (p6) landed in the target slot C");
    assert(slotOf(afterA, p1.id) === "BE", "displaced occupant (p1) landed on Bench (mover's own origin)");

    console.log("\n-- TEST B: stale LineupEntry no longer blocks slot capacity --");
    await sendToFarm({ leagueId, teamId, playerId: p5.id, managerUserId: MANAGER });
    // p5's UTIL LineupEntry row for DATE is now stale (rosterSlot moved to FARM,
    // nothing cleared it — sendToFarm itself is untouched by this feature).
    const staleEntry = await prisma.lineupEntry.findUnique({
      where: { teamId_playerId_gameDate: { teamId, playerId: p5.id, gameDate: new Date(`${DATE}T00:00:00.000Z`) } },
    });
    assert(!!staleEntry && staleEntry.lineupSlot === "UTIL", "p5's stale UTIL LineupEntry still exists after being farmed");
    // Before the fix this would throw ("All 1 UTIL slots are already filled")
    // because the count query didn't filter to currently-active players.
    await setLineupSlot({ leagueId, teamId, playerId: p4.id, date: DATE, slot: "UTIL", managerUserId: MANAGER });
    const afterB = await getLineupForDate(teamId, DATE);
    assert(slotOf(afterB, p4.id) === "UTIL", "p4 moved into UTIL despite p5's stale row — capacity check ignores non-active players");

    console.log("\n-- TEST C: placeOnIrClearingLineup clears that date's LineupEntry --");
    await setIr(p2.id);
    await placeOnIrClearingLineup({ leagueId, teamId, date: DATE, playerId: p2.id, managerUserId: MANAGER });
    const p2Slot = await prisma.rosterSlot.findFirst({ where: { teamId, playerId: p2.id, effectiveTo: null } });
    assert(p2Slot?.slotType === "IR", "p2's roster tier is now IR");
    const p2Entry = await prisma.lineupEntry.findUnique({
      where: { teamId_playerId_gameDate: { teamId, playerId: p2.id, gameDate: new Date(`${DATE}T00:00:00.000Z`) } },
    });
    assert(p2Entry === null, "p2's LineupEntry for that date was cleared");

    console.log("\n-- TEST D: activateFromIrIntoSlot into an empty slot (L is now vacant) --");
    await clearIr(p2.id);
    await activateFromIrIntoSlot({ leagueId, teamId, date: DATE, playerId: p2.id, targetSlot: "L", displacedPlayerId: null, managerUserId: MANAGER });
    const p2SlotAfter = await prisma.rosterSlot.findFirst({ where: { teamId, playerId: p2.id, effectiveTo: null } });
    assert(p2SlotAfter?.slotType === "ACTIVE", "p2 is ACTIVE again");
    const afterD = await getLineupForDate(teamId, DATE);
    assert(slotOf(afterD, p2.id) === "L", "p2 landed directly in the empty L slot");

    console.log("\n-- TEST E: activateFromIrIntoSlot into an occupied slot bumps the occupant to Bench --");
    await clearIr(p7.id);
    await activateFromIrIntoSlot({
      leagueId,
      teamId,
      date: DATE,
      playerId: p7.id,
      targetSlot: "C",
      displacedPlayerId: p6.id, // currently occupying C after TEST A
      managerUserId: MANAGER,
    });
    const p7SlotAfter = await prisma.rosterSlot.findFirst({ where: { teamId, playerId: p7.id, effectiveTo: null } });
    assert(p7SlotAfter?.slotType === "ACTIVE", "p7 is ACTIVE again");
    const afterE = await getLineupForDate(teamId, DATE);
    assert(slotOf(afterE, p7.id) === "C", "p7 (activated) landed in slot C");
    assert(slotOf(afterE, p6.id) === "BE", "p6 (displaced) was bumped to Bench, not a real IR-for-IR swap");

    console.log("\n-- TEST F: activation blocked when the active roster is already full — no corruption --");
    // Active roster cap is 7 (1+1+0+0+2+0+1+2). Currently ACTIVE: p1,p3,p4,p6,p2,p7 = 6.
    await prisma.rosterSlot.create({ data: { teamId, playerId: filler.id, slotType: "ACTIVE" } });
    const activeCountBefore = await prisma.rosterSlot.count({ where: { teamId, slotType: "ACTIVE", effectiveTo: null } });
    assert(activeCountBefore === 7, `active roster is at cap (7) before the blocked attempt, got ${activeCountBefore}`);

    await clearIr(p8.id);
    let threw = false;
    try {
      await activateFromIrIntoSlot({ leagueId, teamId, date: DATE, playerId: p8.id, targetSlot: "BE", displacedPlayerId: null, managerUserId: MANAGER });
    } catch (e) {
      threw = true;
      console.log("correctly blocked:", e instanceof Error ? e.message : e);
    }
    assert(threw, "activation was rejected when the active roster is full");
    const p8SlotAfter = await prisma.rosterSlot.findFirst({ where: { teamId, playerId: p8.id, effectiveTo: null } });
    assert(p8SlotAfter?.slotType === "IR", "p8 is still on IR — no partial corruption from the failed activation");
    const p8Entry = await prisma.lineupEntry.findUnique({
      where: { teamId_playerId_gameDate: { teamId, playerId: p8.id, gameDate: new Date(`${DATE}T00:00:00.000Z`) } },
    });
    assert(p8Entry === null, "p8 got no LineupEntry from the failed activation");

    console.log("\nAll move-feature checks passed.");
  } finally {
    console.log("\n-- cleanup --");
    for (const [playerId, status] of originalStatus) {
      await prisma.player.update({ where: { id: playerId }, data: { officialRosterStatus: status } });
    }
    await prisma.transactionLog.deleteMany({ where: { leagueId } });
    await prisma.lineupEntry.deleteMany({ where: { teamId } });
    await prisma.rosterSlot.deleteMany({ where: { team: { leagueId } } });
    await prisma.team.deleteMany({ where: { leagueId } });
    await prisma.league.delete({ where: { id: leagueId } });
    console.log("cleaned up (restored officialRosterStatus for fixture players, deleted test league)");
  }
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
