// Regression check for LM Tools batch Task 2: the three partial settings
// pages (league/scoring/roster-settings) all spread currentSettingsInput and
// override only their own fields before calling updateLeagueSettings. This
// verifies that merge actually only changes the intended fields (every other
// field byte-equal before/after) and that LeagueSettingsLog rows are written
// only for fields that actually changed value — the same assertion shape
// updateLeagueSettings's own header comment promises.

import { prisma } from "@/lib/db";
import { createLeague, deleteLeague, updateLeagueSettings, type LeagueSettings } from "@/lib/leagues/mutations";
import { currentSettingsInput } from "@/app/leagues/actions";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function getSettings(leagueId: string): Promise<LeagueSettings> {
  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  return league.settingsJson as unknown as LeagueSettings;
}

async function logFieldsSince(leagueId: string, since: Date): Promise<string[]> {
  const rows = await prisma.leagueSettingsLog.findMany({
    where: { leagueId, changedAt: { gt: since } },
    select: { field: true },
  });
  return rows.map((r) => r.field).sort();
}

async function main() {
  const { leagueId } = await createLeague({
    name: "LM Settings Split Check League (delete me)",
    season: 2031,
    managerUserId: "lmsplit-A",
    teamName: "Alpha",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 2, RW: 2, F: 0, D: 4, G: 2, UTIL: 1, BENCH: 6 },
    farmSlots: 6,
    irSlots: 2,
  });
  console.log("league:", leagueId);

  console.log("\n-- general (FAAB/trades/deadline) page's merge --");
  const beforeGeneral = await getSettings(leagueId);
  const t1 = new Date();
  const baseGeneral = await currentSettingsInput(leagueId, "lmsplit-A");
  await updateLeagueSettings({
    ...baseGeneral,
    faabEnabled: true,
    faabBudget: baseGeneral.faabBudget + 10,
    tradeVetoMode: "VOTE",
    tradeDeadline: "2031-12-01",
  });
  const afterGeneral = await getSettings(leagueId);
  assert(afterGeneral.faabEnabled === true && afterGeneral.faabBudget === beforeGeneral.faabBudget + 10, "faabEnabled/faabBudget actually changed");
  assert(afterGeneral.tradeVetoMode === "VOTE" && afterGeneral.tradeDeadline === "2031-12-01", "tradeVetoMode/tradeDeadline actually changed");
  assert(
    JSON.stringify(afterGeneral.scoringConfig) === JSON.stringify(beforeGeneral.scoringConfig),
    "scoringConfig is byte-equal — the general-settings page's merge didn't touch it",
  );
  assert(
    JSON.stringify(afterGeneral.rosterComposition) === JSON.stringify(beforeGeneral.rosterComposition),
    "rosterComposition is byte-equal — the general-settings page's merge didn't touch it",
  );
  assert(
    afterGeneral.farmSlots === beforeGeneral.farmSlots &&
      afterGeneral.irSlots === beforeGeneral.irSlots &&
      afterGeneral.waiverGpThreshold === beforeGeneral.waiverGpThreshold &&
      afterGeneral.callupsPerWeek === beforeGeneral.callupsPerWeek,
    "roster-limit fields are byte-equal — the general-settings page's merge didn't touch them",
  );
  const generalLogFields = await logFieldsSince(leagueId, t1);
  assert(
    JSON.stringify(generalLogFields) === JSON.stringify(["faabBudget", "faabEnabled", "tradeDeadline", "tradeVetoMode"].sort()),
    `LeagueSettingsLog wrote exactly the four changed general fields, got: ${generalLogFields.join(", ")}`,
  );

  console.log("\n-- scoring page's merge --");
  const beforeScoring = await getSettings(leagueId);
  const t2 = new Date();
  const baseScoring = await currentSettingsInput(leagueId, "lmsplit-A");
  await updateLeagueSettings({ ...baseScoring, scoringConfig: { ...baseScoring.scoringConfig, goals: (baseScoring.scoringConfig.goals ?? 0) + 1 } });
  const afterScoring = await getSettings(leagueId);
  assert(afterScoring.scoringConfig.goals === (beforeScoring.scoringConfig.goals ?? 0) + 1, "scoringConfig.goals actually changed");
  assert(afterScoring.faabEnabled === beforeScoring.faabEnabled && afterScoring.faabBudget === beforeScoring.faabBudget, "FAAB fields are byte-equal — the scoring page's merge didn't touch them");
  assert(afterScoring.tradeVetoMode === beforeScoring.tradeVetoMode && afterScoring.tradeDeadline === beforeScoring.tradeDeadline, "trade fields are byte-equal — the scoring page's merge didn't touch them");
  assert(
    JSON.stringify(afterScoring.rosterComposition) === JSON.stringify(beforeScoring.rosterComposition) && afterScoring.farmSlots === beforeScoring.farmSlots,
    "roster fields are byte-equal — the scoring page's merge didn't touch them",
  );
  const scoringLogFields = await logFieldsSince(leagueId, t2);
  assert(JSON.stringify(scoringLogFields) === JSON.stringify(["scoringConfig.goals"]), `LeagueSettingsLog wrote exactly the one changed scoring field, got: ${scoringLogFields.join(", ")}`);

  console.log("\n-- roster-settings page's merge --");
  const beforeRoster = await getSettings(leagueId);
  const t3 = new Date();
  const baseRoster = await currentSettingsInput(leagueId, "lmsplit-A");
  await updateLeagueSettings({
    ...baseRoster,
    farmSlots: baseRoster.farmSlots + 2,
    rosterComposition: { ...baseRoster.rosterComposition, D: baseRoster.rosterComposition.D + 1 },
  });
  const afterRoster = await getSettings(leagueId);
  assert(afterRoster.farmSlots === beforeRoster.farmSlots + 2, "farmSlots actually changed");
  assert(afterRoster.rosterComposition.D === beforeRoster.rosterComposition.D + 1, "rosterComposition.D actually changed");
  assert(
    JSON.stringify(afterRoster.scoringConfig) === JSON.stringify(beforeRoster.scoringConfig),
    "scoringConfig is byte-equal — the roster-settings page's merge didn't touch it",
  );
  assert(
    afterRoster.faabEnabled === beforeRoster.faabEnabled &&
      afterRoster.faabBudget === beforeRoster.faabBudget &&
      afterRoster.tradeVetoMode === beforeRoster.tradeVetoMode &&
      afterRoster.tradeDeadline === beforeRoster.tradeDeadline,
    "FAAB/trade fields are byte-equal — the roster-settings page's merge didn't touch them",
  );
  const rosterLogFields = await logFieldsSince(leagueId, t3);
  assert(
    JSON.stringify(rosterLogFields) === JSON.stringify(["farmSlots", "rosterComposition.D"].sort()),
    `LeagueSettingsLog wrote exactly the two changed roster fields, got: ${rosterLogFields.join(", ")}`,
  );

  console.log("\n-- no-op save writes zero log rows --");
  const t4 = new Date();
  const baseNoop = await currentSettingsInput(leagueId, "lmsplit-A");
  await updateLeagueSettings({ ...baseNoop });
  const noopLogFields = await logFieldsSince(leagueId, t4);
  assert(noopLogFields.length === 0, "resubmitting the exact same settings writes zero LeagueSettingsLog rows");

  console.log("\n-- cleanup --");
  await deleteLeague(leagueId, "lmsplit-A");
  console.log("cleaned up");

  console.log("\nALL CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
