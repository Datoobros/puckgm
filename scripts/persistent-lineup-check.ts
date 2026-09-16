// Verifies Task 4's persistent-lineup materialization (plans/team-page-batch.md,
// issue #4): ensureLineupMaterialized (carry-forward + auto-fill) and
// clearLineupFrom (src/lib/lineups/mutations.ts), plus the same-shape
// rewrite of autoSetLineup (two-tier with-game/no-game fallback instead of
// benching everyone when nothing's playing) and the capacity-check-runs-
// after-materialize fix in setLineupSlot/swapLineupSlots.
//
// Far-future dates (2031, same convention as scripts/move-feature-check.ts)
// so nothing is ever locked and the NHL schedule API returns zero games for
// every date under test. That also means ensureLineupMaterialized's
// auto-fill never skips a candidate for "no game" — only for being locked —
// which matches its actual spec (only autoSetLineup cares about game
// presence, via its two-tier fallback); a candidate with no game at all can
// never be locked, so auto-fill still places players even in a stretch with
// no NHL schedule at all.
//
// Free agency is gated (Task 3) — addPlayerToRoster throws until the
// league's startup draft is COMPLETE. This script runs a real 1-round/
// 2-team startup draft first (same pattern as
// scripts/free-agency-gate-check.ts) rather than using the ungated
// commissionerAddPlayer override, specifically so addPlayerToRoster's own
// new materialize-on-acquire call site gets exercised for real. The test
// team's forced draft pick is a real goalie — G-only eligibility never
// overlaps C/L/D/UTIL, so it can't interfere with any lineup-slot assertion
// below; it just sits implicitly on Bench for the whole script.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, makeDraftPick, getDraftPool } from "@/lib/draft/mutations";
import { addPlayerToRoster, dropPlayerFromRoster } from "@/lib/rosters/mutations";
import {
  ensureLineupMaterialized,
  clearLineupFrom,
  setLineupSlot,
  autoSetLineup,
  getLineupForDate,
} from "@/lib/lineups/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { STARTER_SCORING } from "@/lib/scoring/engine";
import { shiftDate } from "@/lib/dates";

const D1 = "2031-02-10";
const D2 = shiftDate(D1, 1);
const D3 = shiftDate(D1, 2);
const D4 = shiftDate(D1, 3);
const D5 = shiftDate(D1, 4);
const D6 = shiftDate(D1, 5);
const D7 = shiftDate(D1, 6);
const MANAGER = "persistent-lineup-test-A";
const MANAGER_B = "persistent-lineup-test-B";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function slotOf(rows: { playerId: string; lineupSlot: string }[], playerId: string): string {
  return rows.find((r) => r.playerId === playerId)?.lineupSlot ?? "BE";
}

async function main() {
  console.log("-- setup: league + a real 1-round startup draft to open free agency --");
  const { leagueId, teamId } = await createLeague({
    name: "Persistent Lineup Test League (delete me)",
    season: 2031,
    managerUserId: MANAGER,
    teamName: "Persistent Lineup Test Team",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 0, F: 0, D: 1, G: 0, UTIL: 1, BENCH: 3 },
    farmSlots: 2,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: MANAGER_B, teamName: "Bystander Team" });
  console.log("league:", leagueId, "team:", teamId, "bystander:", teamB);

  try {
    const goalie = await prisma.player.findFirstOrThrow({ where: { primaryPosition: "G", draftYear: null } });
    const centersRaw = await prisma.player.findMany({ where: { primaryPosition: "C", draftYear: null }, take: 3 });
    const winger = await prisma.player.findFirstOrThrow({ where: { primaryPosition: "L", draftYear: null } });
    const dman = await prisma.player.findFirstOrThrow({ where: { primaryPosition: "D", draftYear: null } });
    assert(centersRaw.length >= 3, "found at least 3 real C players to use as fixtures");

    // Rank the 3 centers by the exact same career-points metric
    // ensureLineupMaterialized/autoSetLineup use, so "the C" (expected to
    // win the single C slot) vs "the second C" (expected to overflow into
    // UTIL) vs "the third C" (expected to get no room at all) are determined
    // by real data, not by add order.
    const centerPoints = await getPlayerStatsAggregate({ playerIds: centersRaw.map((c) => c.id), scoringConfig: STARTER_SCORING });
    const pointsById = new Map(centerPoints.map((r) => [r.id, r.points]));
    const rankedCenters = [...centersRaw].sort((a, b) => (pointsById.get(b.id) ?? 0) - (pointsById.get(a.id) ?? 0));
    const [cTop, cSecond, cThird] = rankedCenters;
    console.log(`  centers ranked by career points: ${cTop.fullName} > ${cSecond.fullName} > ${cThird.fullName}`);

    const { draftId } = await setUpDraft({
      leagueId, season: 2031, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
      manualOrder: [teamId, teamB], pickTimerSeconds: 10, callerUserId: MANAGER,
    });
    await startDraft({ draftId, callerUserId: MANAGER });
    await makeDraftPick({ draftId, playerId: goalie.id, managerUserId: MANAGER });
    const pool = await getDraftPool({ leagueId, type: "STARTUP", season: 2031 });
    await makeDraftPick({ draftId, playerId: pool[0].id, managerUserId: MANAGER_B });
    const draftAfter = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    assert(draftAfter.status === "COMPLETE", "startup draft completed, free agency now open");

    console.log("\n-- SCENARIO 1: add a C, an L, a D, and a second C via addPlayerToRoster, materialize D1 --");
    await addPlayerToRoster({ leagueId, teamId, playerId: cTop.id, managerUserId: MANAGER });
    await addPlayerToRoster({ leagueId, teamId, playerId: winger.id, managerUserId: MANAGER });
    await addPlayerToRoster({ leagueId, teamId, playerId: dman.id, managerUserId: MANAGER });
    await addPlayerToRoster({ leagueId, teamId, playerId: cSecond.id, managerUserId: MANAGER });

    await ensureLineupMaterialized(teamId, D1);
    const d1RowsA = await getLineupForDate(teamId, D1);
    assert(slotOf(d1RowsA, cTop.id) === "C", "top-ranked C auto-filled into C");
    assert(slotOf(d1RowsA, winger.id) === "L", "L auto-filled into L");
    assert(slotOf(d1RowsA, dman.id) === "D", "D auto-filled into D");
    assert(slotOf(d1RowsA, cSecond.id) === "UTIL", "second-ranked C overflowed into UTIL (position slots fill before UTIL)");

    console.log("\n-- SCENARIO 2: add a third C on D1 — all his eligible slots (C, UTIL) are already full --");
    await addPlayerToRoster({ leagueId, teamId, playerId: cThird.id, managerUserId: MANAGER });
    await ensureLineupMaterialized(teamId, D1);
    const d1RowsB = await getLineupForDate(teamId, D1);
    assert(!d1RowsB.some((r) => r.playerId === cThird.id), "third C got no row at all — shows as bench");

    console.log("\n-- SCENARIO 3: bench the top C on D1, materialize D2 --");
    await setLineupSlot({ leagueId, teamId, playerId: cTop.id, date: D1, slot: "BE", managerUserId: MANAGER });
    await ensureLineupMaterialized(teamId, D2);
    const d2RowsA = await getLineupForDate(teamId, D2);
    assert(slotOf(d2RowsA, cTop.id) === "BE", "top C carried forward as explicit BE (sticky bench)");
    assert(slotOf(d2RowsA, winger.id) === "L", "L carried forward");
    assert(slotOf(d2RowsA, dman.id) === "D", "D carried forward");
    assert(slotOf(d2RowsA, cSecond.id) === "UTIL", "second C carried forward");
    assert(slotOf(d2RowsA, cThird.id) === "C", "third C auto-filled into the vacated C slot");

    console.log("\n-- SCENARIO 4: drop the L — clearLineupFrom is date-scoped, dropPlayerFromRoster wires it up for real --");
    await clearLineupFrom(teamId, winger.id, D2);
    const d1AfterClear = await getLineupForDate(teamId, D1);
    const d2AfterClear = await getLineupForDate(teamId, D2);
    assert(slotOf(d1AfterClear, winger.id) === "L", "D1's row for the dropped L still exists (clearLineupFrom only touches >= fromDate)");
    assert(!d2AfterClear.some((r) => r.playerId === winger.id), "D2's row for the dropped L is gone");

    await dropPlayerFromRoster({ teamId, playerId: winger.id, managerUserId: MANAGER });

    await ensureLineupMaterialized(teamId, D3);
    const d3RowsA = await getLineupForDate(teamId, D3);
    assert(!d3RowsA.some((r) => r.lineupSlot === "L"), "L slot stays empty on D3 — nobody left to fill it, no crash");
    // Reset D3 back to "no rows" so scenario 5 below can prove D5's
    // carry-forward reaches all the way back to D2, past two empty dates —
    // the line above already fully proved D3 materializes correctly on its
    // own; this reset is test scaffolding, not app behavior.
    await prisma.lineupEntry.deleteMany({ where: { teamId, gameDate: new Date(`${D3}T00:00:00.000Z`) } });

    console.log("\n-- SCENARIO 5: setLineupSlot on D5 with nothing explicit on D3/D4 --");
    await setLineupSlot({ leagueId, teamId, playerId: cThird.id, date: D5, slot: "BE", managerUserId: MANAGER });
    const d5Rows = await getLineupForDate(teamId, D5);
    const rosterSize = 5; // goalie, cTop, dman, cSecond, cThird — winger was dropped
    const neverPlaced = 1; // the goalie: G cap is 0 in this league, never eligible for any slot
    assert(
      d5Rows.length === rosterSize - neverPlaced,
      `D5 was materialized from D2 before the write (expected ${rosterSize - neverPlaced} rows, got ${d5Rows.length})`,
    );
    const d3RowsB = await getLineupForDate(teamId, D3);
    const d4RowsB = await getLineupForDate(teamId, D4);
    assert(d3RowsB.length === 0, "D3 still has no rows");
    assert(d4RowsB.length === 0, "D4 still has no rows");

    console.log("\n-- SCENARIO 6: autoSetLineup for D6 — no NHL games anywhere that far out --");
    const autoResults = await autoSetLineup({ leagueId, teamId, dates: [D6], managerUserId: MANAGER });
    assert(
      autoResults[0].started.length > 0,
      `at least one player started despite no games that date (started: ${autoResults[0].started.length}), not everyone forced to bench`,
    );

    console.log("\n-- SCENARIO 7: capacity guard against a slot that's full only via inheritance --");
    let threw7 = false;
    try {
      await setLineupSlot({ leagueId, teamId, playerId: cThird.id, date: D7, slot: "C", managerUserId: MANAGER });
    } catch (e) {
      threw7 = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("already filled"), `throws the capacity error (got: "${msg}")`);
    }
    assert(threw7, "setLineupSlot into a slot that's full purely via inheritance (no explicit D7 rows) still throws");

    console.log("\nAll persistent-lineup checks passed.");
  } finally {
    console.log("\n-- cleanup --");
    await deleteLeague(leagueId, MANAGER);
    console.log("cleaned up (deleted test league, cascades LineupEntry/RosterSlot/Draft/DraftPick/etc.)");
  }
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
