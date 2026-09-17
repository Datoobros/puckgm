// Regression check for draft-fix-batch Task 3 (src/lib/draft/mutations.ts):
// autodraftBatch — the commissioner-only forced-autopick escape hatch for an
// idle draft. Two things to prove: (1) a non-commissioner can't call it, and
// (2) it shares Task 1's resolvingUntil lease correctly, so running it
// concurrently with resolveDraftState (the room's own 3s poll) never
// produces a duplicate pick — same final-state assertions as
// draft-concurrency-check.ts, just with autodraftBatch mixed into the
// concurrent callers instead of only resolveDraftState.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, startDraft, resolveDraftState, autodraftBatch } from "@/lib/draft/mutations";

// Mirrors the private MAX_AUTOPICKS_PER_CALL constant in
// src/lib/draft/mutations.ts — not exported (internal tuning knob), so
// asserted here as the literal value the plan specifies.
const MAX_AUTOPICKS_PER_CALL = 8;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log("== League 1: autodraftBatch alone actually forces picks (tags forced:true) ==");
  const { leagueId: soloLeagueId, teamId: soloA } = await createLeague({
    name: "Draft Autodraft Solo Test League (delete me)",
    season: 2027,
    managerUserId: "draft-auto-solo-A",
    teamName: "Solo A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 2,
    irSlots: 1,
  });
  const { teamId: soloB } = await createTeam({ leagueId: soloLeagueId, managerUserId: "draft-auto-solo-B", teamName: "Solo B" });
  const { draftId: soloDraftId } = await setUpDraft({
    leagueId: soloLeagueId,
    season: 2027,
    type: "STARTUP",
    roundCount: 2,
    orderMode: "MANUAL",
    manualOrder: [soloA, soloB],
    pickTimerSeconds: 600, // long timer, deliberately not expired — autodraftBatch must ignore it
    callerUserId: "draft-auto-solo-A",
  });
  await startDraft({ draftId: soloDraftId, callerUserId: "draft-auto-solo-A" });
  const soloView = await autodraftBatch({ draftId: soloDraftId, callerUserId: "draft-auto-solo-A" });
  assert(soloView.status === "COMPLETE", "a single autodraftBatch call finishes a 4-pick draft (well under MAX_AUTOPICKS_PER_CALL) even with a fresh, unexpired timer");
  const soloForcedLogs = await prisma.transactionLog.count({
    where: { leagueId: soloLeagueId, type: "DRAFT_PICK", payload: { path: ["forced"], equals: true } },
  });
  assert(soloForcedLogs === 4, `all 4 picks were recorded with forced:true — got ${soloForcedLogs}`);
  await deleteLeague(soloLeagueId, "draft-auto-solo-A");
  console.log("cleaned up League 1");

  console.log("\n== League 2: autodraftBatch is commissioner-only and lease-safe alongside resolveDraftState ==");
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Draft Autodraft Test League (delete me)",
    season: 2027,
    managerUserId: "draft-auto-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    // Small on purpose, same shape as draft-concurrency-check.ts — a 5-round
    // draft exactly fills every team so the cap-aware slotType path (ACTIVE
    // then FARM) is exercised, not just the empty case.
    rosterComposition: { positionMode: "SEPARATE", C: 1, LW: 1, RW: 1, F: 0, D: 0, G: 0, UTIL: 0, BENCH: 0 },
    farmSlots: 2,
    irSlots: 1,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "draft-auto-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "draft-auto-C", teamName: "Team C" });
  console.log("league:", leagueId, { teamA, teamB, teamC });

  const { draftId } = await setUpDraft({
    leagueId,
    season: 2027,
    type: "STARTUP",
    roundCount: 5,
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC],
    pickTimerSeconds: 10,
    callerUserId: "draft-auto-A",
  });
  const totalPicks = await prisma.draftPick.count({ where: { draftId } });
  assert(totalPicks === 15, `15 DraftPick rows created (3 teams x 5 rounds) — got ${totalPicks}`);

  await startDraft({ draftId, callerUserId: "draft-auto-A" });

  console.log("\n-- autodraftBatch from a non-commissioner throws --");
  let threw = false;
  try {
    await autodraftBatch({ draftId, callerUserId: "draft-auto-B" });
  } catch (e) {
    threw = e instanceof Error && e.message.includes("Only the league commissioner");
  }
  assert(threw, "a non-commissioner's autodraftBatch call throws, naming the commissioner-only rule");
  const noPicksYet = await prisma.draftPick.count({ where: { draftId, usedOnPlayerId: { not: null } } });
  assert(noPicksYet === 0, "the rejected non-commissioner call recorded zero picks");

  console.log("\n-- concurrent autodraftBatch (commissioner) + resolveDraftState calls, repeated until COMPLETE --");
  let round = 0;
  let status: string = "IN_PROGRESS";
  while (status !== "COMPLETE") {
    round++;
    if (round > 10) throw new Error("Draft never reached COMPLETE after 10 rounds of concurrent calls — likely stuck.");
    // Backdate the deadline before every round so resolveDraftState's own
    // overdue check also wants to autopick — this is what actually puts it
    // in contention for the lease against autodraftBatch (which ignores the
    // deadline entirely), rather than resolveDraftState just returning a
    // fresh view without ever trying to claim it. A winning autodraftBatch
    // call gives the next team a fresh full-window deadline (same as a
    // timely manual pick), so this has to be redone every round.
    await prisma.draft.update({ where: { id: draftId }, data: { currentPickDeadline: new Date(Date.now() - 60 * 60 * 1000) } });

    const before = await prisma.transactionLog.count({ where: { leagueId, type: "DRAFT_PICK" } });
    const results = await Promise.allSettled([
      autodraftBatch({ draftId, callerUserId: "draft-auto-A" }),
      ...Array.from({ length: 5 }, () => resolveDraftState(draftId)),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    assert(rejected.length === 0, `round ${round}: all 6 concurrent calls resolved without throwing`);
    const after = await prisma.transactionLog.count({ where: { leagueId, type: "DRAFT_PICK" } });
    const recordedThisRound = after - before;
    console.log(`  round ${round}: ${recordedThisRound} picks recorded across all 6 concurrent calls`);
    assert(
      recordedThisRound <= MAX_AUTOPICKS_PER_CALL,
      `round ${round}: at most ${MAX_AUTOPICKS_PER_CALL} picks recorded (one winning caller, bounded catch-up) — got ${recordedThisRound}`,
    );

    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    status = draft.status;
  }
  assert(status === "COMPLETE", `draft reached COMPLETE after ${round} round(s) of concurrent calls`);

  console.log("\n-- final-state assertions (same shape as draft-concurrency-check.ts) --");
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

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "draft-auto-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
