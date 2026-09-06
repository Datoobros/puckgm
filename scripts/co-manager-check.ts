// Regression check for the co-manager feature: invite/claim/remove lifecycle,
// full parity with the primary manager on roster/lineup/waiver/FAAB/trade/
// draft-pick mutations, rejection from primary-only actions, the
// one-team-per-league dedup, and the setTeamManager/claimTeam co-manager
// field clearing. Also covers getTeamDraftPicks (own vs. acquired, used vs.
// unused) — the new Draft Picks tab's data source.

import { prisma } from "@/lib/db";
import {
  createLeague,
  createTeam,
  deleteLeague,
  renameTeam,
  setTeamDivision,
  setTeamLogo,
  setTeamManager,
  regenerateTeamClaimCode,
  claimTeam,
  getTeamsForUser,
  regenerateCoManagerClaimCode,
  getTeamByCoManagerClaimCode,
  claimCoManagerSlot,
  removeCoManager,
  updateLeagueSettings,
} from "@/lib/leagues/mutations";
import { addPlayerToRoster, dropPlayerFromRoster, sendToFarm } from "@/lib/rosters/mutations";
import { setLineupSlot } from "@/lib/lineups/mutations";
import { submitWaiverClaim, getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { submitFaBid } from "@/lib/faab/mutations";
import { proposeTrade } from "@/lib/trades/mutations";
import { setUpDraft, makeDraftPick, getTeamDraftPicks } from "@/lib/draft/mutations";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Co-Manager Test League (delete me)",
    season: 2031,
    managerUserId: "cm-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "cm-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "cm-C", teamName: "Team C" });

  console.log("\n-- invite and claim --");
  const { claimCode } = await regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A" });
  await rejects(
    () => regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-B" }),
    "only the primary manager can generate a co-manager invite",
  );
  const found = await getTeamByCoManagerClaimCode(claimCode);
  assert(found?.id === teamA, "the claim code resolves back to team A");

  await claimCoManagerSlot({ claimCode, newSecondManagerUserId: "cm-A2" });
  const afterClaim = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(afterClaim.secondManagerUserId === "cm-A2" && afterClaim.secondManagerClaimCode === null, "claiming sets the co-manager and clears the (single-use) code");

  console.log("\n-- one-team-per-league dedup --");
  const { claimCode: codeForB } = await regenerateCoManagerClaimCode({ leagueId, teamId: teamB, callerUserId: "cm-B" });
  await rejects(
    () => claimCoManagerSlot({ claimCode: codeForB, newSecondManagerUserId: "cm-A2" }),
    "a co-manager of one team can't also claim a co-manager slot on another team in the league",
  );
  await rejects(
    () => claimCoManagerSlot({ claimCode: codeForB, newSecondManagerUserId: "cm-A" }),
    "a primary manager of one team can't also claim a co-manager slot elsewhere",
  );

  console.log("\n-- co-manager has full operational parity with the primary manager --");
  const mcdavid = await prisma.player.findFirstOrThrow({ where: { fullName: "Connor McDavid" } });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: mcdavid.id, managerUserId: "cm-A2" });
  assert(
    (await prisma.rosterSlot.count({ where: { teamId: teamA, playerId: mcdavid.id, effectiveTo: null } })) === 1,
    "co-manager can add a player to the roster",
  );
  await setLineupSlot({ leagueId, teamId: teamA, playerId: mcdavid.id, date: "2031-01-01", slot: "BE", managerUserId: "cm-A2" });
  console.log("  ok: co-manager can set a lineup slot");
  await sendToFarm({ leagueId, teamId: teamA, playerId: mcdavid.id, managerUserId: "cm-A2" });
  assert(
    (await prisma.rosterSlot.findFirst({ where: { teamId: teamA, playerId: mcdavid.id, effectiveTo: null } }))?.slotType === "FARM",
    "co-manager can send a player to farm",
  );
  await dropPlayerFromRoster({ teamId: teamA, playerId: mcdavid.id, managerUserId: "cm-A2" });
  assert(
    (await prisma.rosterSlot.count({ where: { teamId: teamA, playerId: mcdavid.id, effectiveTo: null } })) === 0,
    "co-manager can drop a player",
  );

  const demotedPlayer = await prisma.player.create({ data: { fullName: "Comgr Demoted (delete me)", primaryPosition: "D", careerNhlGp: 200 } });
  await addPlayerToRoster({ leagueId, teamId: teamC, playerId: demotedPlayer.id, managerUserId: "cm-C" });
  await sendToFarm({ leagueId, teamId: teamC, playerId: demotedPlayer.id, managerUserId: "cm-C" });
  await getOrInitWaiverPriority(leagueId);
  await submitWaiverClaim({ leagueId, playerId: demotedPlayer.id, managerUserId: "cm-A2" });
  assert((await prisma.waiverClaim.count({ where: { playerId: demotedPlayer.id, teamId: teamA } })) === 1, "co-manager can submit a waiver claim");

  const dPick = await prisma.player.create({ data: { fullName: "Comgr Trade Player (delete me)", primaryPosition: "L" } });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: dPick.id, managerUserId: "cm-A2" });
  const { tradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamA,
    counterpartyTeamId: teamB,
    managerUserId: "cm-A2",
    give: { playerIds: [dPick.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  assert(!!tradeId, "co-manager can propose a trade");

  // FAAB enabled after the free-instant-add tests above — enabling it turns
  // off addPlayerToRoster's free-add path (established elsewhere), so it
  // has to come last among the roster-building steps.
  await updateLeagueSettings({
    leagueId,
    callerUserId: "cm-A",
    farmSlots: 6,
    irSlots: 2,
    waiverGpThreshold: 80,
    callupsPerWeek: 2,
    scoringConfig: {},
    faabEnabled: true,
    faabBudget: 100,
    faabMinBid: 1,
    faabMaxBid: null,
    tradeVetoMode: "COMMISSIONER",
    tradeDeadline: null,
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    draftPickTradingEnabled: true,
  });
  const faabPlayer = await prisma.player.create({ data: { fullName: "Comgr Faab Player (delete me)", primaryPosition: "C" } });
  await submitFaBid({ leagueId, playerId: faabPlayer.id, amount: 5, targetSlot: "ACTIVE", managerUserId: "cm-A2" });
  assert((await prisma.faBid.count({ where: { playerId: faabPlayer.id, teamId: teamA } })) === 1, "co-manager can submit a FAAB bid");

  console.log("\n-- co-manager is rejected from primary-manager-only actions --");
  await rejects(() => renameTeam({ leagueId, teamId: teamA, callerUserId: "cm-A2", name: "Hijacked" }), "co-manager can't rename the team");
  await rejects(() => setTeamDivision({ leagueId, teamId: teamA, callerUserId: "cm-A2", division: "East" }), "co-manager can't set the team's division");
  await rejects(
    () => setTeamLogo({ leagueId, teamId: teamA, callerUserId: "cm-A2", logoUrl: "https://evil.example.com/x.png" }),
    "co-manager can't set the team's logo",
  );
  await rejects(
    () => regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A2" }),
    "co-manager can't invite a replacement co-manager",
  );
  await rejects(() => removeCoManager({ leagueId, teamId: teamA, callerUserId: "cm-A2" }), "co-manager can't remove themselves");
  await rejects(
    () => setTeamLogo({ leagueId, teamId: teamA, callerUserId: "cm-A", logoUrl: "https://not-vercel-blob.example.com/x.png" }),
    "setTeamLogo rejects a URL that isn't on Vercel Blob's own domain, even from the primary manager",
  );

  console.log("\n-- getTeamsForUser includes co-managed teams --");
  const cm2Teams = await getTeamsForUser("cm-A2");
  assert(cm2Teams.some((t) => t.id === teamA), "the co-manager's teams list includes the team they co-manage");

  console.log("\n-- removeCoManager (primary-only) --");
  await removeCoManager({ leagueId, teamId: teamA, callerUserId: "cm-A" });
  const afterRemove = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(afterRemove.secondManagerUserId === null, "the primary manager can remove the co-manager");
  await rejects(
    () => setLineupSlot({ leagueId, teamId: teamA, playerId: mcdavid.id, date: "2031-01-01", slot: "BE", managerUserId: "cm-A2" }),
    "the removed co-manager no longer has access",
  );

  console.log("\n-- setTeamManager (orphan/reassign) clears a stale co-manager --");
  const { claimCode: code2 } = await regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A" });
  await claimCoManagerSlot({ claimCode: code2, newSecondManagerUserId: "cm-A3" });
  await setTeamManager({ leagueId, teamId: teamA, callerUserId: "cm-A", orphan: true });
  const afterOrphan = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(afterOrphan.secondManagerUserId === null, "orphaning a team clears its co-manager");

  await setTeamManager({ leagueId, teamId: teamA, callerUserId: "cm-A", newManagerUserId: "cm-A4" });
  const { claimCode: code3 } = await regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A4" });
  await claimCoManagerSlot({ claimCode: code3, newSecondManagerUserId: "cm-A5" });
  await setTeamManager({ leagueId, teamId: teamA, callerUserId: "cm-A", newManagerUserId: "cm-A6" });
  const afterReassign = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(afterReassign.secondManagerUserId === null, "reassigning a team's primary manager clears its co-manager");

  console.log("\n-- claimTeam (primary claim link) clears a stale co-manager --");
  const { claimCode: primaryCode } = await regenerateTeamClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A" });
  const { claimCode: code4 } = await regenerateCoManagerClaimCode({ leagueId, teamId: teamA, callerUserId: "cm-A6" });
  await claimCoManagerSlot({ claimCode: code4, newSecondManagerUserId: "cm-A7" });
  await claimTeam({ claimCode: primaryCode, newManagerUserId: "cm-A8" });
  const afterPrimaryClaim = await prisma.team.findUniqueOrThrow({ where: { id: teamA } });
  assert(
    afterPrimaryClaim.managerUserId === "cm-A8" && afterPrimaryClaim.secondManagerUserId === null,
    "claiming a team via its primary claim link clears any stale co-manager",
  );

  console.log("\n-- getTeamDraftPicks --");
  const { draftId } = await setUpDraft({
    leagueId,
    season: 2031,
    type: "STARTUP",
    roundCount: 2,
    orderMode: "MANUAL",
    manualOrder: [teamA, teamB, teamC],
    pickTimerSeconds: 300,
    callerUserId: "cm-A",
  });
  await prisma.draft.update({ where: { id: draftId }, data: { status: "IN_PROGRESS" } });
  // McDavid was added-then-dropped from team A earlier in this script, so
  // he's back in the (league-scoped) draft pool.
  await makeDraftPick({ draftId, playerId: mcdavid.id, managerUserId: "cm-A8" });

  const picksBefore = await getTeamDraftPicks(teamB);
  assert(picksBefore.length === 2, "team B starts with its 2 own picks (2 rounds, 3 teams)");
  assert(
    picksBefore.every((p) => p.isOwnPick && p.originalTeamName === "Team B"),
    "both of team B's picks are marked as its own",
  );

  const teamBsPick = picksBefore.find((p) => !p.used)!;
  const { tradeId: pickTradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamB,
    counterpartyTeamId: teamC,
    managerUserId: "cm-B",
    give: { playerIds: [], pickIds: [teamBsPick.id], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  // Directly move ownership for this check — the trade's own 24h review/
  // processing pipeline is covered by trades-check.ts, not this script.
  await prisma.draftPick.update({ where: { id: teamBsPick.id }, data: { currentOwnerId: teamC } });
  await prisma.trade.update({ where: { id: pickTradeId }, data: { state: "PROCESSED" } });

  const teamCPicks = await getTeamDraftPicks(teamC);
  const acquired = teamCPicks.find((p) => p.id === teamBsPick.id);
  assert(!!acquired && !acquired.isOwnPick && acquired.originalTeamName === "Team B", "an acquired pick shows its original owner, not team C");

  const usedPick = (await getTeamDraftPicks(teamA)).find((p) => p.used);
  assert(!!usedPick && usedPick.usedOnPlayerName === mcdavid.fullName, "a used pick shows who it was used on");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "cm-A");
  await prisma.player.deleteMany({ where: { fullName: { contains: "(delete me)" } } });
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
