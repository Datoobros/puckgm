// Verification for plans/lm-tools-batch.md Task 8 (Draft Recap).
//
// Part 1 is READ-ONLY against the real "Experimenting" league's completed
// startup draft — never writes anything there, same convention as
// reset-experimenting-for-draft.ts's own id+name guard. Part 2 uses a
// disposable, distinctly-named league to cover the SETUP-draft empty state,
// cleaned up by exact name+id at the end.
//
// Usage: npx tsx scripts/draft-recap-check.ts

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { setUpDraft, getDraftRecap } from "@/lib/draft/mutations";

const EXPERIMENTING_LEAGUE_ID = "cmts0s1uu0000lc0405mux8c5";
const EXPERIMENTING_LEAGUE_NAME = "Experimenting";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function checkExperimenting() {
  console.log("\n-- Part 1: real 'Experimenting' league, read-only --");
  const league = await prisma.league.findUnique({ where: { id: EXPERIMENTING_LEAGUE_ID } });
  if (!league || league.name !== EXPERIMENTING_LEAGUE_NAME) {
    throw new Error(
      `Refusing to run — expected league id "${EXPERIMENTING_LEAGUE_ID}" named "${EXPERIMENTING_LEAGUE_NAME}", found: ` +
        (league ? `id "${league.id}" named "${league.name}".` : "no league with that id at all."),
    );
  }

  const draft = await prisma.draft.findFirst({ where: { leagueId: league.id, status: "COMPLETE" } });
  if (!draft) throw new Error("Expected a COMPLETE draft in the Experimenting league — none found.");

  const dbPicks = await prisma.draftPick.findMany({
    where: { draftId: draft.id, usedOnPlayerId: { not: null } },
    include: { originalTeam: true, currentOwner: true, usedOnPlayer: true },
    orderBy: { overallPick: "asc" },
  });
  const logs = await prisma.transactionLog.findMany({ where: { leagueId: league.id, type: "DRAFT_PICK" } });
  const autopickedByPlayerId = new Map<string, boolean>();
  for (const log of logs) {
    const payload = log.payload as { playerId?: string; autopicked?: boolean };
    if (payload.playerId) autopickedByPlayerId.set(payload.playerId, !!payload.autopicked);
  }

  const recap = await getDraftRecap(draft.id);

  assert(recap.draftId === draft.id, "recap.draftId matches the real draft");
  assert(recap.status === "COMPLETE", "recap reports the draft as COMPLETE");
  assert(recap.picks.length === dbPicks.length, `recap pick count (${recap.picks.length}) equals DraftPick rows with usedOnPlayerId set (${dbPicks.length})`);

  const recapByOverall = new Map(recap.picks.map((p) => [p.overallPick, p]));
  let allFieldsMatch = true;
  let autopickedRowsMatchLog = true;
  for (const dbp of dbPicks) {
    const rp = recapByOverall.get(dbp.overallPick!);
    if (
      !rp ||
      rp.teamId !== dbp.currentOwnerId ||
      rp.teamName !== dbp.currentOwner.name ||
      rp.round !== dbp.round ||
      rp.playerId !== dbp.usedOnPlayerId ||
      rp.playerName !== dbp.usedOnPlayer!.fullName
    ) {
      allFieldsMatch = false;
      console.error("  mismatch on overallPick", dbp.overallPick, { rp, dbp });
    }
    const expectedAutopicked = autopickedByPlayerId.get(dbp.usedOnPlayerId!) ?? false;
    if (!rp || rp.autopicked !== expectedAutopicked) autopickedRowsMatchLog = false;
  }
  assert(allFieldsMatch, "every pick's team/player/round/overall matches the underlying DraftPick row");
  assert(autopickedRowsMatchLog, "every pick's autopicked flag matches the DRAFT_PICK TransactionLog payload");
  assert(recap.picks.every((p) => p.autopicked), "this league's draft was fully autodrafted — every recap pick carries the AUTO flag");
}

async function checkSetupDraftEmptyState() {
  console.log("\n-- Part 2: disposable league, draft still in SETUP --");
  const LEAGUE_NAME = "LM Tools Task 8 (delete me)";
  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: 2027,
    managerUserId: "lm-tools-task8-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "lm-tools-task8-B", teamName: "Team B" });
  console.log("disposable league:", leagueId, { teamA, teamB });

  const { draftId } = await setUpDraft({
    leagueId,
    season: 2027,
    type: "STARTUP",
    roundCount: 1,
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB],
    pickTimerSeconds: 90,
    callerUserId: "lm-tools-task8-A",
  });

  const recap = await getDraftRecap(draftId);
  assert(recap.status === "SETUP", "recap reports the draft as SETUP");
  assert(recap.picks.length === 0, "recap is empty for a draft that hasn't started");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lm-tools-task8-A");
  const stillThere = await prisma.league.findUnique({ where: { id: leagueId } });
  assert(stillThere === null, `disposable league "${LEAGUE_NAME}" (${leagueId}) deleted`);
}

async function main() {
  await checkExperimenting();
  await checkSetupDraftEmptyState();
  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
