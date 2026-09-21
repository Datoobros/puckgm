// Regression check for the player-profile modal's data layer
// (plans/player-modal-batch.md Task 2, src/lib/players/profile.ts):
// currentAndLastSeason, NHL_TEAM_NAMES coverage, and getPlayerProfile's
// header/rank/seasons/game-log/transactions/status/watching shape — against
// a disposable league on the shared prod database, using a real player
// (Connor McDavid) rather than a stub, since his game/season history is
// what actually exercises the stats and game-log logic.

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { addPlayerToRoster, sendToFarm, callUpToActive } from "@/lib/rosters/mutations";
import { submitWaiverClaim } from "@/lib/waivers/mutations";
import { proposeTrade, respondToTrade, processDueTrades } from "@/lib/trades/mutations";
import { setUpDraft } from "@/lib/draft/mutations";
import { toggleWatchlist } from "@/lib/players/watchlist";
import { getPlayerProfile } from "@/lib/players/profile";
import { currentAndLastSeason } from "@/lib/players/seasons";
import { NHL_TEAM_NAMES, NHL_TEAM_ABBREVS } from "@/lib/nhl/client";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function backdateReview(tradeId: string) {
  await prisma.trade.update({ where: { id: tradeId }, data: { reviewEndsAt: new Date(Date.now() - 1000) } });
}

async function main() {
  console.log("\n-- static checks: NHL_TEAM_NAMES coverage, currentAndLastSeason --");
  for (const abbrev of NHL_TEAM_ABBREVS) {
    assert(!!NHL_TEAM_NAMES[abbrev], `NHL_TEAM_NAMES has an entry for ${abbrev}`);
  }
  const nowish = currentAndLastSeason("2026-09-20");
  assert(nowish.thisSeason.value === "2026" && nowish.lastSeason?.value === "2025", "currentAndLastSeason(2026-09-20) -> 2026 / 2025");
  const midSeason = currentAndLastSeason("2026-03-01");
  assert(
    midSeason.thisSeason.value === "2025" && midSeason.lastSeason === null,
    "currentAndLastSeason(2026-03-01) -> 2025 / null (no 2024 season entry exists)",
  );

  const { leagueId, teamId: teamA } = await createLeague({
    name: "Player Modal Check (delete me)",
    season: 2030,
    managerUserId: "pmc-A",
    teamName: "Team A",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "pmc-B", teamName: "Team B" });
  console.log("league:", leagueId, { teamA, teamB });

  console.log("\n-- throwaway draft to open free agency --");
  // Marked COMPLETE directly rather than run through startDraft +
  // autodraftBatch: autodraft picks the highest-ranked available players
  // first, which on the real player pool means real stars (verified: it
  // drafted Connor McDavid and Nikita Kucherov the first time this script
  // ran) — exactly the players this script needs to start out unowned.
  // getFreeAgencyStatus only checks for a COMPLETE STARTUP draft row; it
  // doesn't care whether any picks were actually made.
  const { draftId } = await setUpDraft({
    leagueId, season: 2020, type: "STARTUP", roundCount: 1, orderMode: "MANUAL",
    manualOrder: [teamA, teamB], pickTimerSeconds: 600, callerUserId: "pmc-A",
  });
  await prisma.draft.update({ where: { id: draftId }, data: { status: "COMPLETE", currentPickDeadline: null } });

  const mcdavid = await prisma.player.findFirst({ where: { fullName: { contains: "Connor McDavid" } } });
  assert(!!mcdavid, "Connor McDavid found in the real Player table (never create a stub for him)");
  const mcdavidId = mcdavid!.id;

  console.log("\n-- profile before any roster move --");
  const before = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-A" });
  assert(before.player.sweaterNumber === 97, `sweaterNumber is 97 (from the most recent stat line) — got ${before.player.sweaterNumber}`);
  assert(before.player.nhlTeamName === "Edmonton Oilers", `nhlTeamName is Edmonton Oilers — got ${before.player.nhlTeamName}`);
  assert(before.player.firstName === "Connor", `firstName split correctly — got "${before.player.firstName}"`);
  assert(["Healthy", "IR", "LTIR"].includes(before.player.healthStatus), "healthStatus is one of the three values");
  assert(before.status.ownedBy === null, "not yet owned by anyone");
  assert(before.status.onMyTeam === null, "not on pmc-A's team yet");
  assert(before.status.freeAgencyOpen === true, "free agency open after the throwaway draft");
  assert(before.status.faab === null, "faab null — league never turns FAAB on in this script");
  assert(before.seasons[0].label.startsWith("2026-27"), `seasons[0] is the 2026-27 row — got "${before.seasons[0].label}"`);
  assert(before.seasons[0].stats.gamesIngested === 0, "2026-27 has 0 games ingested (preseason)");
  assert(before.seasons[0].atoi === null, "2026-27 ATOI null with 0 games");
  assert(before.seasons[1].label === "2025-26 Season", `seasons[1] is 2025-26 — got "${before.seasons[1].label}"`);
  assert(before.seasons[1].stats.gamesIngested > 0, "2025-26 has real games ingested");
  assert(before.seasons[1].stats.points > 0, "2025-26 has real points");
  assert(/^\d+:\d\d$/.test(before.seasons[1].atoi ?? ""), `2025-26 ATOI is mm:ss — got "${before.seasons[1].atoi}"`);
  if (before.rank === null) {
    assert(before.averagePoints === null, "rank null -> averagePoints also null (no 2026-27 games yet)");
  } else {
    assert(
      before.rank.position >= 1 && before.rank.position <= before.rank.groupSize && before.rank.groupLabel === "C",
      "2026-27 season has started for real — rank is a valid 1..groupSize position among Cs instead",
    );
  }
  assert(before.gameLog.length === 25, `game log capped at 25 — got ${before.gameLog.length}`);
  for (const row of before.gameLog) {
    assert(row.opponent !== null && /^@?[A-Z]{3}$/.test(row.opponent), `game log opponent well-formed — got "${row.opponent}"`);
    assert(row.toi !== null, "game log TOI present");
    assert(row.result !== null && /^[WL] \d+-\d+( \((OT|SO)\))?$/.test(row.result), `game log result well-formed — got "${row.result}"`);
  }
  assert(before.transactions.length === 0, "no transactions yet");
  assert(before.watching === false, "not watched yet");

  console.log("\n-- addPlayerToRoster to Team A --");
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: mcdavidId, managerUserId: "pmc-A" });
  const afterAddA = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-A" });
  assert(afterAddA.status.onMyTeam?.slotType === "ACTIVE", "onMyTeam ACTIVE for pmc-A after add");
  assert(afterAddA.status.ownedBy?.teamId === teamA, "ownedBy is Team A");
  assert(afterAddA.transactions[0]?.kind === "ADD" && afterAddA.transactions[0]?.verb === "Added", "latest transaction is Added");
  assert(afterAddA.transactions[0]?.headline === "by Team A", `headline is "by Team A" — got "${afterAddA.transactions[0]?.headline}"`);
  const afterAddB = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-B" });
  assert(afterAddB.status.onMyTeam === null, "onMyTeam null for pmc-B");
  assert(afterAddB.status.ownedBy?.teamName === "Team A", "ownedBy.teamName is Team A for pmc-B's view");

  console.log("\n-- sendToFarm from Team A, waiver claim from Team B --");
  const { waiverExposed } = await sendToFarm({ leagueId, teamId: teamA, playerId: mcdavidId, managerUserId: "pmc-A" });
  assert(waiverExposed, "McDavid (well over 80 career GP) is waiver-exposed on demotion");
  const beforeClaimB = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-B" });
  assert(beforeClaimB.status.waivers !== null, "pmc-B sees the waivers block");
  assert(beforeClaimB.status.waivers?.myPendingClaimId === null, "no pending claim yet");
  await submitWaiverClaim({ leagueId, playerId: mcdavidId, managerUserId: "pmc-B" });
  const afterClaimB = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-B" });
  assert(afterClaimB.status.waivers?.myPendingClaimId !== null, "pending claim id set after submitWaiverClaim");
  assert(afterClaimB.transactions[0]?.kind === "SEND_DOWN", "latest transaction is SEND_DOWN");
  assert((afterClaimB.transactions[0]?.headline ?? "").includes("exposed to waivers"), "SEND_DOWN headline mentions waiver exposure");

  console.log("\n-- call back up (voids the pending claim), then a processed 2-for-1 trade with a pick going back --");
  await callUpToActive({ leagueId, teamId: teamA, playerId: mcdavidId, managerUserId: "pmc-A" });
  const fillerPlayer = await prisma.player.create({ data: { fullName: "Player Modal Check Filler (delete me)", primaryPosition: "D" } });
  await addPlayerToRoster({ leagueId, teamId: teamA, playerId: fillerPlayer.id, managerUserId: "pmc-A" });
  const pickBack = await prisma.draftPick.create({
    data: { leagueId, season: 2032, round: 1, originalTeamId: teamB, currentOwnerId: teamB },
  });
  const { tradeId } = await proposeTrade({
    leagueId, proposingTeamId: teamA, counterpartyTeamId: teamB, managerUserId: "pmc-A",
    give: { playerIds: [mcdavidId, fillerPlayer.id], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [pickBack.id], faabAmount: 0 },
  });
  await respondToTrade({ tradeId, managerUserId: "pmc-B", accept: true });
  await backdateReview(tradeId);
  await processDueTrades();
  const tradeState = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
  assert(tradeState.state === "PROCESSED", "the 2-for-1 trade processed cleanly");

  console.log("\n-- a second, still-PROPOSED trade must stay confidential --");
  await proposeTrade({
    leagueId, proposingTeamId: teamB, counterpartyTeamId: teamA, managerUserId: "pmc-B",
    give: { playerIds: [mcdavidId], pickIds: [], faabAmount: 0 },
    receive: { playerIds: [], pickIds: [], faabAmount: 0 },
  });

  const afterTrade = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-A" });
  assert(afterTrade.transactions[0]?.kind === "TRADE" && afterTrade.transactions[0]?.verb === "Traded", "latest transaction is the processed trade");
  assert(afterTrade.transactions[0]?.headline === "from Team A to Team B", `headline is "from Team A to Team B" — got "${afterTrade.transactions[0]?.headline}"`);
  assert(afterTrade.transactions[0]?.details.length === 3, `trade details has 3 lines (2 players + 1 pick) — got ${afterTrade.transactions[0]?.details.length}`);
  const pickDetail = afterTrade.transactions[0]?.details.find((d) => /pick/.test(d.asset));
  assert(!!pickDetail && /^\d{4} Rd \d pick \(orig\. .+\)$/.test(pickDetail.asset), `pick detail asset well-formed — got "${pickDetail?.asset}"`);
  assert(afterTrade.transactions.filter((t) => t.kind === "TRADE").length === 1, "exactly one TRADE event — the still-PROPOSED trade doesn't leak");

  console.log("\n-- watchlist --");
  await toggleWatchlist(leagueId, "pmc-B", mcdavidId);
  const watchB = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-B" });
  const watchA = await getPlayerProfile({ leagueId, playerId: mcdavidId, viewerUserId: "pmc-A" });
  assert(watchB.watching === true, "pmc-B is watching");
  assert(watchA.watching === false, "pmc-A is not watching (per-user)");

  console.log("\n-- a prospect (no stat lines) --");
  const prospect = await prisma.player.findFirst({ where: { draftYear: { not: null } } });
  if (!prospect) {
    console.log("  (no prospect with draftYear set in the DB — skipping this section)");
  } else {
    const prospectProfile = await getPlayerProfile({ leagueId, playerId: prospect.id, viewerUserId: "pmc-A" });
    assert(!!prospectProfile.player.draftPedigree, `draftPedigree non-empty — got "${prospectProfile.player.draftPedigree}"`);
    assert(prospectProfile.player.sweaterNumber === null, "prospect has no sweater number (no stat lines)");
    assert(prospectProfile.seasons.every((s) => s.stats.gamesIngested === 0), "prospect has 0 games ingested in every season row");
    assert(prospectProfile.rank === null, "prospect has no rank (0 games this season)");
    assert(prospectProfile.gameLog.length === 0, "prospect has an empty game log");
  }

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "pmc-A");
  await prisma.player.deleteMany({ where: { fullName: "Player Modal Check Filler (delete me)" } });
  console.log("cleaned up (McDavid and the real prospect row were never touched)");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
