// Regression check for the commissioner-tools batch: co-commissioners,
// team/manager management (orphan/reassign/claim links/delete), direct
// roster overrides, draft settings editing, draft-pick-trading toggle,
// draft-pick-ownership reset, roster-composition/schedule unlocking, and
// divisions. Direct roster overrides' full-bypass behavior is implicitly
// covered by every other script's cap-bypass precedent already established
// (waiver/FAAB awards) — this file focuses on what's actually new.

import { prisma } from "@/lib/db";
import {
  createLeague,
  createTeam,
  deleteLeague,
  updateLeagueSettings,
  getLeagueCommissioners,
  isLeagueCommissioner,
  setCoCommissioner,
  setTeamManager,
  addTeamAsCommissioner,
  regenerateTeamClaimCode,
  getTeamByClaimCode,
  claimTeam,
  deleteTeam,
  setTeamDivision,
  regenerateInviteCode,
} from "@/lib/leagues/mutations";
import { addPlayerToRoster, dropPlayerFromRoster, sendToFarm, commissionerAddPlayer } from "@/lib/rosters/mutations";
import { setLineupSlot } from "@/lib/lineups/mutations";
import { submitWaiverClaim, processExpiredWaivers, getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { submitFaBid, processFaabBids } from "@/lib/faab/mutations";
import { proposeTrade, respondToTrade, castTradeVeto, forceProcessTrade, getTradeableAssets } from "@/lib/trades/mutations";
import { setUpDraft, updateDraftSetup, cancelDraftSetup, resetDraftPickOwnership } from "@/lib/draft/mutations";
import { generateSchedule, resetSchedule } from "@/lib/matchups/mutations";
import { getStandings } from "@/lib/matchups/standings";
import { STARTER_SCORING } from "@/lib/scoring/engine";

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

const BASE_SETTINGS_INPUT = {
  farmSlots: 6,
  irSlots: 2,
  waiverGpThreshold: 80,
  callupsPerWeek: 2,
  scoringConfig: {},
  faabEnabled: false,
  faabBudget: 100,
  faabMinBid: 1,
  faabMaxBid: null as number | null,
  tradeVetoMode: "COMMISSIONER" as const,
  tradeDeadline: null as string | null,
  rosterComposition: { positionMode: "SEPARATE" as const, C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
  draftPickTradingEnabled: true,
};

async function main() {
  const { leagueId, teamId: teamA } = await createLeague({
    name: "Commissioner Tools Test League (delete me)",
    season: 2031,
    managerUserId: "ctools-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "ctools-B", teamName: "Team B" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "ctools-C", teamName: "Team C" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "ctools-D", teamName: "Team D" });
  console.log("league:", leagueId, { teamA, teamB, teamC, teamD });

  console.log("\n-- co-commissioners --");
  await setCoCommissioner({ leagueId, teamId: teamB, callerUserId: "ctools-A", isCoCommissioner: true });
  assert((await getLeagueCommissioners(leagueId)).includes("ctools-B"), "granting co-commissioner adds them to the commissioner list");
  assert(await isLeagueCommissioner(leagueId, "ctools-B"), "isLeagueCommissioner recognizes the co-commissioner");

  await rejects(
    () => setCoCommissioner({ leagueId, teamId: teamC, callerUserId: "ctools-B", isCoCommissioner: true }),
    "a co-commissioner can't promote another team to co-commissioner",
  );
  await rejects(
    () => setCoCommissioner({ leagueId, teamId: teamB, callerUserId: "ctools-B", isCoCommissioner: false }),
    "a co-commissioner can't even demote themselves",
  );
  const { inviteCode: coCommInviteCode } = await regenerateInviteCode(leagueId, "ctools-B");
  assert(!!coCommInviteCode, "a co-commissioner can perform a real commissioner-only action (regenerate invite code)");

  console.log("\n-- co-commissioner trade conflict-of-interest --");
  const vetPlayer = await prisma.player.create({ data: { fullName: "Ctools Vet (delete me)", primaryPosition: "C", careerNhlGp: 400 } });
  await addPlayerToRoster({ leagueId, teamId: teamB, playerId: vetPlayer.id, managerUserId: "ctools-B" });
  const { tradeId: coiTradeId } = await proposeTrade({
    leagueId,
    proposingTeamId: teamB,
    counterpartyTeamId: teamC,
    managerUserId: "ctools-B",
    give: { playerIds: [vetPlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: coiTradeId, managerUserId: "ctools-C", accept: true });
  await rejects(
    () => castTradeVeto({ tradeId: coiTradeId, managerUserId: "ctools-B" }),
    "a co-commissioner who's a party to the trade can't veto it, even in COMMISSIONER mode",
  );
  await rejects(
    () => forceProcessTrade({ tradeId: coiTradeId, callerUserId: "ctools-B" }),
    "a co-commissioner who's a party to the trade can't force-process it",
  );
  await forceProcessTrade({ tradeId: coiTradeId, callerUserId: "ctools-A" });
  const coiTrade = await prisma.trade.findUniqueOrThrow({ where: { id: coiTradeId } });
  assert(coiTrade.state === "PROCESSED", "a non-party commissioner can force-process the same trade");

  await setCoCommissioner({ leagueId, teamId: teamB, callerUserId: "ctools-A", isCoCommissioner: false });
  assert(!(await isLeagueCommissioner(leagueId, "ctools-B")), "revoking co-commissioner status removes the power");

  console.log("\n-- orphaning freezes a team; reassigning un-freezes it --");
  const demotedPlayer = await prisma.player.create({ data: { fullName: "Ctools Demoted (delete me)", primaryPosition: "D", careerNhlGp: 200 } });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: demotedPlayer.id, managerUserId: "ctools-A" });
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamA, playerId: demotedPlayer.id, managerUserId: "ctools-A" });
  assert(waiverExposed, "the demoted 200-GP player is waiver-exposed, opening a claim window");

  await submitWaiverClaim({ leagueId, playerId: demotedPlayer.id, managerUserId: "ctools-D" });

  await updateLeagueSettings({ leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT, faabEnabled: true });
  const biddablePlayer = await prisma.player.create({ data: { fullName: "Ctools Biddable (delete me)", primaryPosition: "C" } });
  await submitFaBid({ leagueId, playerId: biddablePlayer.id, amount: 5, targetSlot: "ACTIVE", managerUserId: "ctools-D" });

  await setTeamManager({ leagueId, teamId: teamD, callerUserId: "ctools-A", orphan: true });
  const orphanedD = await prisma.team.findUniqueOrThrow({ where: { id: teamD } });
  assert(orphanedD.state === "ORPHAN_FROZEN", "orphaning sets the team state to ORPHAN_FROZEN");

  // Orphaning leaves managerUserId untouched, so reassigning a team back to
  // its own (already-orphaned) manager must not be rejected as "that person
  // already manages a team" — the duplicate-manager check has to exclude
  // the team being reassigned itself.
  await setTeamManager({ leagueId, teamId: teamD, callerUserId: "ctools-A", newManagerUserId: "ctools-D" });
  const selfReassignedD = await prisma.team.findUniqueOrThrow({ where: { id: teamD } });
  assert(selfReassignedD.state === "ACTIVE", "reassigning a team back to its own already-orphaned manager un-freezes it");
  await setTeamManager({ leagueId, teamId: teamD, callerUserId: "ctools-A", orphan: true });

  const freeAgent = await prisma.player.create({ data: { fullName: "Ctools Free Agent (delete me)", primaryPosition: "R" } });
  await rejects(() => addPlayerToRoster({ leagueId, teamId: teamD, playerId: freeAgent.id, managerUserId: "ctools-D" }), "a frozen team can't add a player");
  await rejects(() => sendToFarm({ leagueId, teamId: teamD, playerId: freeAgent.id, managerUserId: "ctools-D" }), "a frozen team can't send a player to farm");
  await rejects(() => submitWaiverClaim({ leagueId, playerId: freeAgent.id, managerUserId: "ctools-D" }), "a frozen team can't submit a waiver claim");
  await rejects(() => submitFaBid({ leagueId, playerId: freeAgent.id, amount: 1, targetSlot: "ACTIVE", managerUserId: "ctools-D" }), "a frozen team can't submit a FAAB bid");
  await rejects(
    () => setLineupSlot({ leagueId, teamId: teamD, playerId: freeAgent.id, date: "2027-01-01", slot: "BE", managerUserId: "ctools-D" }),
    "a frozen team's lineup can't be edited",
  );

  await prisma.rosterSlot.updateMany({ where: { teamId: teamA, playerId: demotedPlayer.id, slotType: "FARM" }, data: { waiverExpiresAt: new Date(Date.now() - 1000) } });
  const waiverResults = await processExpiredWaivers();
  const waiverOutcome = waiverResults.find((r) => r.playerId === demotedPlayer.id);
  assert(waiverOutcome?.outcome === "EXPIRED_UNCLAIMED", "a frozen team's claim doesn't win at resolution time — the pick clears unclaimed instead");
  const clearedClaim = await prisma.waiverClaim.findFirst({ where: { playerId: demotedPlayer.id, teamId: teamD } });
  assert(clearedClaim?.result === "CLEARED", "the frozen team's claim is resolved (CLEARED), not left PENDING forever");

  const faabResults = await processFaabBids();
  const faabOutcome = faabResults.find((r) => r.playerId === biddablePlayer.id);
  assert(!faabOutcome || faabOutcome.outcome !== "WON", "a frozen team's bid doesn't win at resolution time either");
  const lostBid = await prisma.faBid.findFirst({ where: { playerId: biddablePlayer.id, teamId: teamD } });
  assert(lostBid?.result === "LOST", "the frozen team's bid is resolved LOST");

  await setTeamManager({ leagueId, teamId: teamD, callerUserId: "ctools-A", newManagerUserId: "ctools-D2" });
  const reassignedD = await prisma.team.findUniqueOrThrow({ where: { id: teamD } });
  assert(reassignedD.state === "ACTIVE" && reassignedD.managerUserId === "ctools-D2", "reassigning un-freezes the team under its new manager");
  // FAAB is on for this league now, so instant-add is normally disabled —
  // commissionerAddPlayer bypasses that (as designed), which still proves
  // the point: it would have thrown on ORPHAN_FROZEN before reassignment.
  await commissionerAddPlayer({ leagueId, teamId: teamD, playerId: freeAgent.id, callerUserId: "ctools-A" });
  const freeAgentSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamD, playerId: freeAgent.id, effectiveTo: null } });
  assert(!!freeAgentSlot, "the reassigned (un-frozen) team can have a player added again");

  console.log("\n-- commissioner direct roster override --");
  const overridePlayer = await prisma.player.create({ data: { fullName: "Ctools Override (delete me)", primaryPosition: "L" } });
  await commissionerAddPlayer({ leagueId, teamId: teamC, playerId: overridePlayer.id, callerUserId: "ctools-A" });
  const overrideSlot = await prisma.rosterSlot.findFirst({ where: { teamId: teamC, playerId: overridePlayer.id, effectiveTo: null } });
  assert(overrideSlot?.slotType === "ACTIVE", "commissionerAddPlayer lands the player on the target team's ACTIVE roster directly");

  console.log("\n-- add team, claim link --");
  const { teamId: placeholderTeamId } = await addTeamAsCommissioner({ leagueId, callerUserId: "ctools-A", teamName: "Placeholder Team" });
  const placeholder = await prisma.team.findUniqueOrThrow({ where: { id: placeholderTeamId } });
  assert(placeholder.managerUserId === "ctools-A", "a commissioner-added team starts owned by the commissioner administratively");

  const { claimCode } = await regenerateTeamClaimCode({ leagueId, teamId: placeholderTeamId, callerUserId: "ctools-A" });
  const foundByCode = await getTeamByClaimCode(claimCode);
  assert(foundByCode?.id === placeholderTeamId, "the claim code resolves back to the placeholder team");

  const claimResult = await claimTeam({ claimCode, newManagerUserId: "ctools-claimer" });
  assert(claimResult.teamId === placeholderTeamId, "claiming the team succeeds");
  const claimed = await prisma.team.findUniqueOrThrow({ where: { id: placeholderTeamId } });
  assert(claimed.managerUserId === "ctools-claimer" && claimed.claimCode === null, "claiming reassigns the manager and clears the (single-use) claim code");
  await rejects(() => claimTeam({ claimCode, newManagerUserId: "ctools-someoneelse" }), "the same claim code can't be used twice");

  console.log("\n-- delete team --");
  const { teamId: freshTeamId } = await addTeamAsCommissioner({ leagueId, callerUserId: "ctools-A", teamName: "Fresh Untouched Team" });
  await deleteTeam({ leagueId, teamId: freshTeamId, callerUserId: "ctools-A" });
  assert((await prisma.team.findUnique({ where: { id: freshTeamId } })) === null, "a completely untouched team can be hard-deleted");
  await rejects(
    () => deleteTeam({ leagueId, teamId: teamC, callerUserId: "ctools-A" }),
    "a team with real history (rostered players, a trade) can't be hard-deleted",
  );

  console.log("\n-- draft settings editing --");
  const currentTeams = await prisma.team.findMany({ where: { leagueId } });
  const teamCount = currentTeams.length;
  const { draftId } = await setUpDraft({
    leagueId, season: 2031, type: "STARTUP", roundCount: 2, orderMode: "MANUAL",
    manualOrder: currentTeams.map((t) => t.id), pickTimerSeconds: 600, callerUserId: "ctools-A",
  });
  assert((await prisma.draftPick.count({ where: { draftId } })) === teamCount * 2, "2 rounds x every team = that many picks at setup");

  await updateDraftSetup({ draftId, callerUserId: "ctools-A", roundCount: 3 });
  assert((await prisma.draftPick.count({ where: { draftId } })) === teamCount * 3, "growing to 3 rounds adds picks in place");

  await updateDraftSetup({ draftId, callerUserId: "ctools-A", roundCount: 1 });
  const shrunkPicks = await prisma.draftPick.findMany({ where: { draftId }, orderBy: { overallPick: "asc" } });
  assert(shrunkPicks.length === teamCount, "shrinking back to 1 round removes the extra picks");
  assert(shrunkPicks.every((p) => p.originalTeamId === p.currentOwnerId), "every remaining pick's ownership is untouched (still original)");

  const pickToTrade = shrunkPicks.find((p) => p.originalTeamId === teamD)!;
  const { tradeId: pickTradeId } = await proposeTrade({
    leagueId, proposingTeamId: teamD, counterpartyTeamId: teamC, managerUserId: "ctools-D2",
    give: { playerIds: [], pickIds: [pickToTrade.id], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });
  await respondToTrade({ tradeId: pickTradeId, managerUserId: "ctools-C", accept: true });
  await forceProcessTrade({ tradeId: pickTradeId, callerUserId: "ctools-A" });
  const tradedPick = await prisma.draftPick.findUniqueOrThrow({ where: { id: pickToTrade.id } });
  assert(tradedPick.currentOwnerId === teamC, "the pick's ownership actually moved via the trade");

  await rejects(
    () => updateDraftSetup({ draftId, callerUserId: "ctools-A", roundCount: 2 }),
    "editing a draft is refused once any of its picks has ever been traded",
  );
  await rejects(
    () => cancelDraftSetup({ draftId, callerUserId: "ctools-A" }),
    "cancelling a draft is refused for the same reason",
  );

  console.log("\n-- draft pick trading toggle --");
  await updateLeagueSettings({ leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT, faabEnabled: true, draftPickTradingEnabled: false });
  const assetsA = await getTradeableAssets(teamA);
  const anotherPick = assetsA.picks.find((p) => p.id !== pickToTrade.id) ?? assetsA.picks[0];
  await rejects(
    () =>
      proposeTrade({
        leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "ctools-A",
        give: { playerIds: [], pickIds: [anotherPick.id], faabAmount: 0 },
        receive: { playerIds: [], pickIds: [], faabAmount: 0 },
      }),
    "a pick trade is refused once draft-pick trading is turned off",
  );
  await updateLeagueSettings({ leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT, faabEnabled: true, draftPickTradingEnabled: true });

  console.log("\n-- reset draft pick ownership --");
  const { resetCount } = await resetDraftPickOwnership(leagueId, "ctools-A");
  assert(resetCount >= 1, "at least the traded pick gets reset");
  const revertedPick = await prisma.draftPick.findUniqueOrThrow({ where: { id: pickToTrade.id } });
  assert(revertedPick.currentOwnerId === revertedPick.originalTeamId, "the previously-traded pick reverts to its original owner");

  console.log("\n-- roster composition editable, positionMode locked --");
  await rejects(
    () =>
      updateLeagueSettings({
        leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT,
        rosterComposition: { positionMode: "COMBINED", C: 0, LW: 0, RW: 0, F: 6, D: 4, G: 2, UTIL: 1, BENCH: 6 },
      }),
    "changing positionMode after creation is refused",
  );
  await rejects(
    () =>
      updateLeagueSettings({
        leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT,
        rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 3, D: 4, G: 2, UTIL: 1, BENCH: 6 },
      }),
    "a nonzero F in SEPARATE mode is refused",
  );
  await updateLeagueSettings({
    leagueId, callerUserId: "ctools-A", ...BASE_SETTINGS_INPUT,
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 5, G: 2, UTIL: 1, BENCH: 6 },
  });
  const afterRosterEdit = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  assert((afterRosterEdit.settingsJson as any).rosterComposition.D === 5, "the numeric roster composition field actually changed");

  console.log("\n-- schedule reset --");
  const futureStart = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await generateSchedule({ leagueId, season: 2031, startDate: futureStart, weekCount: 2, callerUserId: "ctools-A" });
  await resetSchedule(leagueId, "ctools-A", 2031);
  assert((await prisma.matchupPeriod.count({ where: { leagueId, season: 2031 } })) === 0, "resetting an unplayed schedule removes every period");

  await generateSchedule({ leagueId, season: 2031, startDate: futureStart, weekCount: 2, callerUserId: "ctools-A" });
  const firstPeriod = await prisma.matchupPeriod.findFirstOrThrow({ where: { leagueId, season: 2031 }, orderBy: { periodNo: "asc" } });
  await prisma.matchupPeriod.update({ where: { id: firstPeriod.id }, data: { endDate: new Date(Date.now() - 1000) } });
  await rejects(() => resetSchedule(leagueId, "ctools-A", 2031), "resetting is refused once a week has already completed");

  console.log("\n-- divisions (display-only) --");
  await setTeamDivision({ leagueId, teamId: teamA, callerUserId: "ctools-A", division: "East" });
  await setTeamDivision({ leagueId, teamId: teamB, callerUserId: "ctools-A", division: "East" });
  await setTeamDivision({ leagueId, teamId: teamC, callerUserId: "ctools-A", division: "West" });
  const standings = await getStandings(leagueId, 2031, STARTER_SCORING);
  const divisionByTeam = new Map(standings.map((r) => [r.teamId, r.division]));
  assert(divisionByTeam.get(teamA) === "East" && divisionByTeam.get(teamB) === "East", "two teams share a division");
  assert(divisionByTeam.get(teamC) === "West", "a third team is in a different division");
  assert(divisionByTeam.get(teamD) === null, "a team with no division set shows null, not an error");
  const priorityStillWorks = await getOrInitWaiverPriority(leagueId);
  assert(priorityStillWorks.length > 0, "unrelated league mechanics (waiver priority) are unaffected by any of this");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "ctools-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
