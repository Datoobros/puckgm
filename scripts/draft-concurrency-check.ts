// Regression check for draft-fix-batch Task 1 (src/lib/draft/mutations.ts):
// the atomic pick claim, the resolver lease, cap-aware slotType, round-count
// validation, and bounded catch-up — the fixes for the four distinct ways
// the real "Experimenting" startup draft went wrong (every pick recorded
// ~4 times, no roster-cap awareness, an unbounded catch-up loop). Two
// leagues: League 1 drives 6 truly concurrent resolveDraftState calls at a
// backdated draft and asserts the result is exactly correct, not just
// "close"; League 2 is a minimal, separate check that a ROOKIE draft's
// picks land on FARM (League 1's teams are deliberately packed full by the
// end, so it can't also prove FARM-first ordering with room to spare).

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, resolveDraftState, getMaxDraftRounds } from "@/lib/draft/mutations";

// Mirrors the private MAX_AUTOPICKS_PER_CALL constant in
// src/lib/draft/mutations.ts — not exported (internal tuning knob), so
// asserted here as the literal value the plan specifies.
const MAX_AUTOPICKS_PER_CALL = 8;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log("== League 1: atomic claim, cap-aware slotType, round-count validation, bounded catch-up ==");
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Draft Concurrency Test League (delete me)",
    season: 2027,
    managerUserId: "draft-conc-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    // Small on purpose (plan: "small caps, e.g. active 3, farm 2") so a
    // 5-round draft exactly fills every team and the cap-aware slotType
    // logic (ACTIVE then FARM) actually gets exercised, not just the empty
    // case.
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 2,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "draft-conc-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "draft-conc-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  const maxRounds = await getMaxDraftRounds(leagueId);
  assert(maxRounds === 5, `getMaxDraftRounds is 5 (active cap 3 + farm 2, nothing rostered yet) — got ${maxRounds}`);

  console.log("\n-- setUpDraft with roundCount = 6 throws the max-rounds message --");
  let overRoundsThrew = false;
  try {
    await setUpDraft({
      leagueId,
      season: 2027,
      type: "STARTUP",
      roundCount: 6,
      orderMode: "MANUAL",
      manualOrder: [teamA, teamB, teamC],
      pickTimerSeconds: 10,
      callerUserId: "draft-conc-A",
    });
  } catch (e) {
    overRoundsThrew = e instanceof Error && e.message.includes("at most 5");
  }
  assert(overRoundsThrew, "roundCount=6 throws naming the max (5), and creates no stray Draft row");
  const strayDraft = await prisma.draft.findUnique({ where: { leagueId_season_type: { leagueId, season: 2027, type: "STARTUP" } } });
  assert(strayDraft === null, "the rejected roundCount=6 attempt left no Draft row behind");

  console.log("\n-- 5-round STARTUP draft (3 teams x 5 = 15 picks), 10s timer --");
  const { draftId } = await setUpDraft({
    leagueId,
    season: 2027,
    type: "STARTUP",
    roundCount: 5,
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC],
    pickTimerSeconds: 10,
    callerUserId: "draft-conc-A",
  });
  const totalPicks = await prisma.draftPick.count({ where: { draftId } });
  assert(totalPicks === 15, `15 DraftPick rows created (3 teams x 5 rounds) — got ${totalPicks}`);

  await startDraft({ draftId, callerUserId: "draft-conc-A" });
  // Backdate by a full hour (not just past the 10s timer) so every pick is
  // simultaneously overdue — this is what the real botched draft hit: a
  // long stretch with nobody watching, then a flood of readers all at once.
  await prisma.draft.update({ where: { id: draftId }, data: { currentPickDeadline: new Date(Date.now() - 60 * 60 * 1000) } });

  console.log("\n-- 6 concurrent resolveDraftState calls per round, repeated until COMPLETE --");
  // Only one of the 6 concurrent calls in a round can ever win the
  // resolvingUntil lease (Postgres serializes the competing updateMany
  // writes to the same Draft row; every loser sees the lease already held
  // and returns immediately without picking) — so the total DRAFT_PICK
  // logs created *in one round* is exactly what a single resolveDraftState
  // call recorded, and must never exceed MAX_AUTOPICKS_PER_CALL.
  let round = 0;
  let status: string = "IN_PROGRESS";
  while (status !== "COMPLETE") {
    round++;
    if (round > 10) throw new Error("Draft never reached COMPLETE after 10 rounds of concurrent resolves — likely stuck.");
    const before = await prisma.transactionLog.count({ where: { leagueId, type: "DRAFT_PICK" } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => resolveDraftState(draftId)));
    const rejected = results.filter((r) => r.status === "rejected");
    assert(rejected.length === 0, `round ${round}: all 6 concurrent resolveDraftState calls resolved without throwing`);
    const after = await prisma.transactionLog.count({ where: { leagueId, type: "DRAFT_PICK" } });
    const recordedThisRound = after - before;
    console.log(`  round ${round}: ${recordedThisRound} picks recorded across all 6 concurrent calls`);
    assert(
      recordedThisRound <= MAX_AUTOPICKS_PER_CALL,
      `round ${round}: at most ${MAX_AUTOPICKS_PER_CALL} picks recorded (one winning call, bounded catch-up) — got ${recordedThisRound}`,
    );
    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    status = draft.status;
  }
  assert(status === "COMPLETE", `draft reached COMPLETE after ${round} round(s) of concurrent resolves`);

  console.log("\n-- final-state assertions --");
  const openSlots = await prisma.rosterSlot.findMany({ where: { team: { leagueId }, effectiveTo: null } });
  assert(openSlots.length === 15, `exactly 15 open roster slots (5 x 3) — got ${openSlots.length}`);

  const draftPickLogs = await prisma.transactionLog.count({ where: { leagueId, type: "DRAFT_PICK" } });
  assert(draftPickLogs === 15, `exactly 15 DRAFT_PICK transaction logs — got ${draftPickLogs}`);

  const countByPlayer = new Map<string, number>();
  for (const slot of openSlots) countByPlayer.set(slot.playerId, (countByPlayer.get(slot.playerId) ?? 0) + 1);
  assert(
    [...countByPlayer.values()].every((n) => n === 1),
    "zero players with more than one open roster slot (no duplicate-drafted player)",
  );

  const unusedPicks = await prisma.draftPick.count({ where: { draftId, usedOnPlayerId: null } });
  assert(unusedPicks === 0, "every pick's usedOnPlayerId is set — none left null");
  const usedPicksOnce = await prisma.draftPick.findMany({ where: { draftId }, select: { usedOnPlayerId: true } });
  const distinctUsedPlayers = new Set(usedPicksOnce.map((p) => p.usedOnPlayerId));
  assert(distinctUsedPlayers.size === 15, "all 15 usedOnPlayerId values are distinct — no pick reused another's player");

  for (const [label, teamId] of [
    ["A", teamA],
    ["B", teamB],
    ["C", teamC],
  ] as const) {
    const active = openSlots.filter((s) => s.teamId === teamId && s.slotType === "ACTIVE").length;
    const farm = openSlots.filter((s) => s.teamId === teamId && s.slotType === "FARM").length;
    assert(active === 3 && farm === 2, `Team ${label}: exactly 3 ACTIVE + 2 FARM — got ${active} ACTIVE, ${farm} FARM`);
  }

  console.log("\n-- cleanup: League 1 --");
  await deleteLeague(leagueId, "draft-conc-A");
  console.log("cleaned up League 1");

  console.log("\n== League 2: a ROOKIE draft's picks land on FARM (room to spare in ACTIVE) ==");
  const { leagueId: leagueId2, teamId: team2A } = await createLeague({
    name: "Draft Concurrency Rookie Test League (delete me)",
    season: 2027,
    managerUserId: "draft-conc-rookie-A",
    teamName: "Rookie Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 1, G: 1, UTIL: 0, BENCH: 0 },
    farmSlots: 3,
    irSlots: 1,
  });
  const { teamId: team2B } = await createTeam({ leagueId: leagueId2, managerUserId: "draft-conc-rookie-B", teamName: "Rookie Team B" });
  console.log("league:", leagueId2, { team2A, team2B });

  const { draftId: rookieDraftId } = await setUpDraft({
    leagueId: leagueId2,
    season: 2025, // real ingested class, per scripts/draft-check.ts
    type: "ROOKIE",
    roundCount: 1,
    orderMode: "MANUAL",
    manualOrder: [team2A, team2B],
    pickTimerSeconds: 10,
    callerUserId: "draft-conc-rookie-A",
  });
  await startDraft({ draftId: rookieDraftId, callerUserId: "draft-conc-rookie-A" });
  await prisma.draft.update({ where: { id: rookieDraftId }, data: { currentPickDeadline: new Date(Date.now() - 60 * 60 * 1000) } });
  await resolveDraftState(rookieDraftId);
  const rookieFinal = await prisma.draft.findUniqueOrThrow({ where: { id: rookieDraftId } });
  assert(rookieFinal.status === "COMPLETE", "the 1-round ROOKIE draft (2 picks) completes in one resolve call");

  const rookieSlots = await prisma.rosterSlot.findMany({ where: { team: { leagueId: leagueId2 }, effectiveTo: null } });
  assert(rookieSlots.length === 2, `2 rookie picks landed as open roster slots — got ${rookieSlots.length}`);
  assert(
    rookieSlots.every((s) => s.slotType === "FARM"),
    "every ROOKIE pick landed on FARM, not ACTIVE, even with ACTIVE room to spare",
  );

  console.log("\n-- cleanup: League 2 --");
  await deleteLeague(leagueId2, "draft-conc-rookie-A");
  console.log("cleaned up League 2");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
