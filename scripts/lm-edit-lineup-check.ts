// Regression check for LM Roster Moves: Edit Lineup (LM Tools batch Task 12,
// plans/lm-tools-batch.md). Task 12 added no new primitives to
// src/lib/lineups/mutations.ts — the new logic lives entirely in
// settings/roster-moves/actions.ts's lmEditLineupAction, a "use server"
// function that (like every other action in this batch) calls auth.protect()
// and can't run outside a real request. Same convention as
// scripts/lm-roster-moves-check.ts: exercise the underlying lib pieces
// (isLeagueCommissioner for the gate, setLineupSlot for the actual write)
// with the exact call shape the action uses — managerUserId =
// team.managerUserId, after a commissioner check — rather than the action
// wrapper itself.
//
// Covers: a commissioner setting a slot on another team's lineup is reflected
// by getLineupForDate; an ineligible slot for the player's position is
// refused; a player whose real game has already started is refused (a real
// historical EDM game — the app's own ingested-data convention already
// treats 2026-01-15 as known-good real data, see PROGRESS.md); a
// non-commissioner caller fails the isLeagueCommissioner gate the action
// itself depends on, before ever reaching setLineupSlot.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, isLeagueCommissioner } from "@/lib/leagues/mutations";
import { commissionerAddPlayer } from "@/lib/rosters/mutations";
import { setLineupSlot, getLineupForDate } from "@/lib/lineups/mutations";
import { shiftDate, todayUTC } from "@/lib/dates";

const LEAGUE_NAME = "LM Tools Task 12 (delete me)";
const COMMISSIONER = "lm-editlineup-A";
const MANAGER_B = "lm-editlineup-B";

// Far in the future, so nothing under test here is ever locked — same
// convention as persistent-lineup-check.ts.
const SAFE_DATE = shiftDate(todayUTC(), 365 * 5);

// A real, already-completed date/team pair — Edmonton definitely played a
// real game on 2026-01-15 (the same date PROGRESS.md's matchups section
// cross-checks McDavid's real box score against), so isLocked is guaranteed
// true against real wall-clock "now" without needing to fake the NHL
// schedule API.
const LOCKED_DATE = "2026-01-15";
const LOCKED_TEAM_ABBREV = "EDM";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function rejects(fn: () => Promise<unknown>, msg: string) {
  let threw = false;
  let message = "";
  try {
    await fn();
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `${msg} (message: "${message}")`);
}

function slotOf(rows: { playerId: string; lineupSlot: string }[], playerId: string): string {
  return rows.find((r) => r.playerId === playerId)?.lineupSlot ?? "BE";
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: 2031,
    managerUserId: COMMISSIONER,
    teamName: "Edit Lineup Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 2, G: 1, UTIL: 1, BENCH: 4 },
    farmSlots: 2,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: MANAGER_B, teamName: "Edit Lineup Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  // ---- Setup: a center on Team B's active roster, added via the LM
  // override so free agency's startup-draft gate doesn't need its own
  // throwaway draft for this check. ---------------------------------------
  const centerB = await prisma.player.create({ data: { fullName: "LM EditLineup Center (delete me)", primaryPosition: "C" } });
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: centerB.id, callerUserId: COMMISSIONER });

  console.log("\n-- commissioner sets a slot on another team's lineup --");
  assert(await isLeagueCommissioner(leagueId, COMMISSIONER), "COMMISSIONER is the league commissioner");
  // Exactly the call lmEditLineupAction makes: managerUserId is TEAM B's own
  // manager, not the commissioner's own id — the commissioner check already
  // happened (asserted above); this call is what the action does next.
  await setLineupSlot({ leagueId, teamId: teamB, playerId: centerB.id, date: SAFE_DATE, slot: "C", managerUserId: MANAGER_B });
  const afterSet = await getLineupForDate(teamB, SAFE_DATE);
  assert(slotOf(afterSet, centerB.id) === "C", "getLineupForDate reflects the commissioner-driven slot change on Team B");

  console.log("\n-- an ineligible slot for the position is refused --");
  await rejects(
    () => setLineupSlot({ leagueId, teamId: teamB, playerId: centerB.id, date: SAFE_DATE, slot: "D", managerUserId: MANAGER_B }),
    "a Center (C) can't be placed in the D slot",
  );
  const afterIneligible = await getLineupForDate(teamB, SAFE_DATE);
  assert(slotOf(afterIneligible, centerB.id) === "C", "the rejected ineligible-slot attempt left the player's slot unchanged");

  console.log("\n-- a player whose real game already started is refused --");
  const lockedPlayer = await prisma.player.create({
    data: { fullName: "LM EditLineup Locked (delete me)", primaryPosition: "C", currentNhlOrg: LOCKED_TEAM_ABBREV },
  });
  await commissionerAddPlayer({ leagueId, teamId: teamB, playerId: lockedPlayer.id, callerUserId: COMMISSIONER });
  await rejects(
    () => setLineupSlot({ leagueId, teamId: teamB, playerId: lockedPlayer.id, date: LOCKED_DATE, slot: "C", managerUserId: MANAGER_B }),
    `a player on ${LOCKED_TEAM_ABBREV} for the real, already-completed ${LOCKED_DATE} game is locked`,
  );

  console.log("\n-- a non-commissioner caller fails the gate the action itself depends on --");
  assert(!(await isLeagueCommissioner(leagueId, MANAGER_B)), "Team B's own manager is NOT the league commissioner — lmEditLineupAction's requireCommissionerTeam would throw before ever calling setLineupSlot");

  console.log("\n-- cleanup --");
  const testPlayerIds = [centerB.id, lockedPlayer.id];
  await deleteLeague(leagueId, COMMISSIONER);
  await prisma.player.deleteMany({ where: { id: { in: testPlayerIds } } });
  const leagueGone = await prisma.league.findUnique({ where: { id: leagueId } });
  assert(leagueGone === null, "league deleted");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
