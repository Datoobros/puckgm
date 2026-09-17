// Regression check for draft-fix-batch Task 2 (src/lib/draft/ranking.ts):
// needs-based value-over-replacement autopick, replacing "just take the
// highest career-points player" — the bug that drafted 24 goalies in a row
// against the real "Experimenting" league. Two parts:
//
// 1. Pure-function checks (no DB) against hand-computed numbers from the
//    plan's own bench-share rule, not from running the code — computeGroupTargets
//    for Experimenting's exact COMBINED composition, that a team already
//    holding 2 goalies doesn't autopick a 3rd while skater needs are wide
//    open, and that a single team's 19-pick autodraft sequence stays within
//    the plan's <=3 G / >=4 D bounds.
// 2. A DB run: a disposable 3-team league using Experimenting's exact
//    composition (C:0 D:4 F:6 G:2 LW:0 RW:0 UTIL:1 BENCH:6, COMBINED, farm 6,
//    IR 2), a 19-round STARTUP draft fully autodrafted via repeated
//    resolveDraftState calls against a backdated deadline, asserting every
//    team lands <=3 G, >=4 D, >=6 F, and nobody's double-rostered.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague, type RosterComposition } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, resolveDraftState } from "@/lib/draft/mutations";
import { computeGroupTargets, goalieHardCap, chooseAutopick, type RankedPoolPlayer } from "@/lib/draft/ranking";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function makePlayers(group: string, values: number[]): RankedPoolPlayer[] {
  return values.map((value, i) => ({
    id: `${group}-${i}`,
    fullName: `${group} Player ${i}`,
    primaryPosition: group === "G" ? "G" : group === "D" ? "D" : "C",
    currentNhlOrg: "TST",
    group,
    value,
  }));
}

// Experimenting's exact roster composition (from the plan's "What happened"
// investigation) — the shape that produced 69 goalies out of 139 drafted
// players under the old career-points-only ranking.
const EXPERIMENTING_COMP: RosterComposition = {
  positionMode: "COMBINED",
  C: 0,
  LW: 0,
  RW: 0,
  F: 6,
  D: 4,
  G: 2,
  UTIL: 1,
  BENCH: 6,
};

function pureFunctionChecks() {
  console.log("== Pure-function checks (no DB) ==");

  console.log("\n-- computeGroupTargets, Experimenting's exact COMBINED composition --");
  // By the plan's rule: starters F=6, D=4, G=2. Bench pool = UTIL(1) +
  // BENCH(6) = 7, split proportionally to skater starter counts (F:6, D:4 of
  // 10 total): F share = round(7*6/10 = 4.2) = 4, D share = round(7*4/10 =
  // 2.8) = 3 -- sums to exactly 7, no remainder to redistribute. Goalies get
  // a flat +1, not a proportional share (that's the whole point: a
  // proportional share would let "need" for goalies stay open-ended again).
  const targets = computeGroupTargets(EXPERIMENTING_COMP);
  assert(targets.F === 10, `F target is 6 starters + 4 bench share = 10 -- got ${targets.F}`);
  assert(targets.D === 7, `D target is 4 starters + 3 bench share = 7 -- got ${targets.D}`);
  assert(targets.G === 3, `G target is 2 starters + 1 flat bench share = 3 -- got ${targets.G}`);
  const hardCap = goalieHardCap(EXPERIMENTING_COMP);
  assert(hardCap === 3, `goalieHardCap is capFor(G)+1 = 3, same number as the G target -- got ${hardCap}`);

  console.log("\n-- a team with 2 goalies never autopicks a 3rd while skater needs are wide open --");
  {
    // Goalies score higher in absolute terms (the original bug), but the
    // position is deep and flat here -- the drop from best to replacement
    // is small. Skaters have a much steeper drop-off. This is exactly the
    // shape value-over-replacement is supposed to catch: a team's raw-value
    // ranking would still say "goalie" first, but VOR says "skater."
    const pool: RankedPoolPlayer[] = [
      ...makePlayers("F", [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 1]),
      ...makePlayers("D", [95, 85, 75, 65, 55, 45, 35, 25, 15, 5]),
      ...makePlayers("G", [150, 148, 146, 144, 142]),
    ];
    const need = { F: 10, D: 7, G: 1 }; // have.G = 2 already -> max(0, 3-2) = 1
    const decision = chooseAutopick({
      pool,
      positionMode: "COMBINED",
      need,
      remainingLeagueNeed: need,
      hardCapG: 3,
      haveG: 2,
    });
    assert(!!decision, "chooseAutopick returned a decision");
    assert(
      decision!.player.group !== "G",
      `with 2 goalies already and F/D needs wide open, autopick takes a skater, not a 3rd goalie -- got group ${decision!.player.group}`,
    );
    assert(decision!.reason === "NEED", `reason is NEED (a group still needs players) -- got ${decision!.reason}`);
  }

  console.log("\n-- a single team's 19-pick autodraft sequence stays within <=3 G, >=4 D --");
  {
    let pool: RankedPoolPlayer[] = [
      ...makePlayers("F", Array.from({ length: 40 }, (_, i) => 100 - i * 2)),
      ...makePlayers("D", Array.from({ length: 30 }, (_, i) => 90 - i * 2)),
      // Deep, flat goalie pool -- same "scores higher" shape as the real
      // bug, but without a steep replacement cliff, same as the test above.
      ...makePlayers("G", Array.from({ length: 15 }, (_, i) => 150 - i)),
    ];
    const have: Record<string, number> = { F: 0, D: 0, G: 0 };
    const sequence: string[] = [];
    for (let pick = 0; pick < 19; pick++) {
      const need = {
        F: Math.max(0, targets.F - have.F),
        D: Math.max(0, targets.D - have.D),
        G: Math.max(0, targets.G - have.G),
      };
      // Single-team simulation: this team is the whole "league," so
      // remainingLeagueNeed is just its own need.
      const decision = chooseAutopick({
        pool,
        positionMode: "COMBINED",
        need,
        remainingLeagueNeed: need,
        hardCapG: 3,
        haveG: have.G,
      });
      if (!decision) throw new Error(`pool ran out at pick ${pick + 1}`);
      const group = decision.player.group!;
      sequence.push(group);
      have[group] += 1;
      pool = pool.filter((p) => p.id !== decision.player.id);
    }
    console.log(`  sequence: ${sequence.join(" ")}`);
    const countG = sequence.filter((g) => g === "G").length;
    const countD = sequence.filter((g) => g === "D").length;
    const countF = sequence.filter((g) => g === "F").length;
    assert(countG <= 3, `at most 3 goalies across 19 picks -- got ${countG}`);
    assert(countD >= 4, `at least 4 defencemen across 19 picks -- got ${countD}`);
    console.log(`  (F: ${countF}, D: ${countD}, G: ${countG})`);
  }

  console.log("\nALL PURE-FUNCTION CHECKS PASSED");
}

async function dbCheck() {
  console.log("\n== DB run: 3-team league, Experimenting's exact composition, 19-round STARTUP draft ==");
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Draft Ranking Test League (delete me)",
    season: 2027,
    managerUserId: "draft-rank-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: EXPERIMENTING_COMP,
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "draft-rank-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "draft-rank-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  const { draftId } = await setUpDraft({
    leagueId,
    season: 2027,
    type: "STARTUP",
    roundCount: 19, // exactly activeRosterCap for this composition -- no farm spillover expected
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC],
    pickTimerSeconds: 10,
    callerUserId: "draft-rank-A",
  });
  const totalPicks = await prisma.draftPick.count({ where: { draftId } });
  assert(totalPicks === 57, `57 DraftPick rows created (3 teams x 19 rounds) -- got ${totalPicks}`);

  await startDraft({ draftId, callerUserId: "draft-rank-A" });
  await prisma.draft.update({ where: { id: draftId }, data: { currentPickDeadline: new Date(Date.now() - 60 * 60 * 1000) } });

  console.log("\n-- fully autodrafting via repeated resolveDraftState calls --");
  let status: string = "IN_PROGRESS";
  let calls = 0;
  while (status !== "COMPLETE") {
    calls++;
    if (calls > 20) throw new Error("Draft never reached COMPLETE after 20 resolveDraftState calls -- likely stuck.");
    const view = await resolveDraftState(draftId);
    status = view.status;
  }
  console.log(`  draft reached COMPLETE after ${calls} resolveDraftState call(s)`);

  console.log("\n-- final-state assertions --");
  const openSlots = await prisma.rosterSlot.findMany({
    where: { team: { leagueId }, effectiveTo: null },
    include: { player: true },
  });
  assert(openSlots.length === 57, `exactly 57 open roster slots (3 teams x 19) -- got ${openSlots.length}`);

  const countByPlayer = new Map<string, number>();
  for (const slot of openSlots) countByPlayer.set(slot.playerId, (countByPlayer.get(slot.playerId) ?? 0) + 1);
  assert(
    [...countByPlayer.values()].every((n) => n === 1),
    "zero players with more than one open roster slot (no duplicate-drafted player)",
  );

  const FORWARD_POSITIONS = new Set(["C", "L", "R"]);
  for (const [label, teamId] of [
    ["A", teamA],
    ["B", teamB],
    ["C", teamC],
  ] as const) {
    const teamSlots = openSlots.filter((s) => s.teamId === teamId);
    assert(teamSlots.length === 19, `Team ${label}: exactly 19 open roster slots -- got ${teamSlots.length}`);
    const g = teamSlots.filter((s) => s.player.primaryPosition === "G").length;
    const d = teamSlots.filter((s) => s.player.primaryPosition === "D").length;
    const f = teamSlots.filter((s) => s.player.primaryPosition && FORWARD_POSITIONS.has(s.player.primaryPosition)).length;
    console.log(`  Team ${label}: F=${f} D=${d} G=${g} (${f + d + g} of 19 accounted for)`);
    assert(g <= 3, `Team ${label}: at most 3 goalies -- got ${g}`);
    assert(d >= 4, `Team ${label}: at least 4 defencemen -- got ${d}`);
    assert(f >= 6, `Team ${label}: at least 6 forwards -- got ${f}`);
  }

  console.log("\n-- first 15 picks by position, Team A (for the report) --");
  const teamAPicks = await prisma.draftPick.findMany({
    where: { draftId, currentOwnerId: teamA },
    orderBy: { overallPick: "asc" },
    include: { usedOnPlayer: true },
    take: 15,
  });
  for (const p of teamAPicks) {
    console.log(`  R${p.round} #${p.overallPick}: ${p.usedOnPlayer?.fullName} (${p.usedOnPlayer?.primaryPosition})`);
  }

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "draft-rank-A");
  console.log("cleaned up");

  console.log("\nALL DB CHECKS PASSED");
}

async function main() {
  pureFunctionChecks();
  await dbCheck();
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
