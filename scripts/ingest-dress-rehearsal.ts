// Opening-night dress rehearsal for the daily-ingest cron
// (src/app/api/cron/daily-ingest/route.ts). Runs the same phases, in the
// same order, timing each one — the point is answering "does a full night's
// work fit in Vercel's 60s function limit" with a number, not a guess.
//
// Usage: npx tsx --env-file=.env scripts/ingest-dress-rehearsal.ts [date]
// `date` defaults to 2025-10-11, the busiest known slate (16 games, all 32
// teams playing) — the worst case for roster-sync scope, which is what
// actually threatens the 60s budget (see route.ts's maxDuration comment).
//
// The ingest phase below reimplements ingestRecentDates's 3-day heal-forward
// window locally (calling the real, unmodified ingestDate per date) rather
// than importing ingestRecentDates itself, because that function always
// anchors on yesterdayUTC() — real wall-clock "yesterday" — and this script
// needs to rehearse against a fixed historical slate instead. The lineup
// phase is the opposite: it deliberately uses the real today/yesterday
// dates, not the rehearsal date, because lineup materialization is
// inherently anchored to calendar-today — pointing it at a 2025 date would
// write bogus historical LineupEntry rows for teams that didn't play, or
// didn't exist, back then.
import { prisma } from "@/lib/db";
import { ingestDate, yesterdayUTC } from "@/lib/ingest/daily";
import { shiftDate, todayUTC } from "@/lib/dates";
import { syncTeamsRosters } from "@/lib/players/sync";
import { syncInjuryStatuses } from "@/lib/players/injuries";
import { processExpiredWaivers } from "@/lib/waivers/mutations";
import { processFaabBids } from "@/lib/faab/mutations";
import { processDueTrades } from "@/lib/trades/mutations";
import { processDuePlayoffs } from "@/lib/matchups/playoffs";
import { ensureLineupMaterialized } from "@/lib/lineups/mutations";

const HEAL_DAYS = 3;
const SOFT_BUDGET_SECONDS = 45; // leaves headroom under Vercel's 60s hard limit
const HARD_BUDGET_SECONDS = 60;

interface PhaseTiming {
  phase: string;
  seconds: number;
  detail: string;
}

async function timed<T>(phase: string, fn: () => Promise<T>, detail: (result: T) => string): Promise<{ result: T; timing: PhaseTiming }> {
  const start = performance.now();
  const result = await fn();
  const seconds = (performance.now() - start) / 1000;
  return { result, timing: { phase, seconds, detail: detail(result) } };
}

async function main() {
  const rehearsalDate = process.argv[2] ?? "2025-10-11";
  console.log(`\n=== Ingest dress rehearsal for ${rehearsalDate} ===\n`);

  const leaguesBefore = await prisma.league.count();
  const teamsBefore = await prisma.team.count();
  const rosterSlotsBefore = await prisma.rosterSlot.count();
  const statLinesBefore = await prisma.gameStatLine.count();

  const timings: PhaseTiming[] = [];
  const overallStart = performance.now();

  // Phase 1: heal-forward ingest, anchored at the rehearsal date instead of
  // real "yesterday" — see file header.
  const healWindow = Array.from({ length: HEAL_DAYS }, (_, i) => shiftDate(rehearsalDate, -i));
  const { result: ingestResults, timing: ingestTiming } = await timed(
    "ingest (heal-forward)",
    async () => {
      const results = [];
      for (const date of healWindow) {
        results.push(await ingestDate(date));
      }
      return results;
    },
    (results) => {
      const gamesIngested = results.reduce((s, r) => s + r.gamesIngested, 0);
      const errors = results.reduce((s, r) => s + r.errors.length, 0);
      return `dates=${healWindow.join(",")} gamesIngested=${gamesIngested} errors=${errors}`;
    },
  );
  timings.push(ingestTiming);

  const teamsInvolved = [...new Set(ingestResults.flatMap((r) => r.teamsInvolved))];

  // Phase 2: roster sync, scoped to the teams that actually played across
  // the heal window — the real cron route's scoping, exercised at its worst
  // realistic case (a 16-game day touches all 32 teams).
  const { result: rosterResults, timing: rosterTiming } = await timed(
    "rosterSync",
    () => syncTeamsRosters(teamsInvolved),
    (results) => {
      const synced = results.reduce((s, r) => s + r.playersSynced, 0);
      const failed = results.reduce((s, r) => s + r.failures.length, 0);
      return `teams=${teamsInvolved.length} synced=${synced} failed=${failed}`;
    },
  );
  timings.push(rosterTiming);

  // Phase 3: injury sync — unscoped, same as the real route.
  const { result: injuryResult, timing: injuryTiming } = await timed(
    "injurySync",
    () => syncInjuryStatuses(),
    (r) => `matched=${r.matched} cleared=${r.cleared}`,
  );
  timings.push(injuryTiming);

  // Phases 4-6: waivers, FAAB, trades — real, unscoped, same as the route.
  // Read-only in effect against the live DB right now: nothing is due (the
  // real cron run confirmed empty results for all three today).
  const { result: waiverResults, timing: waiverTiming } = await timed(
    "waivers",
    () => processExpiredWaivers(),
    (r) => `processed=${r.length}`,
  );
  timings.push(waiverTiming);

  const { result: faabResults, timing: faabTiming } = await timed(
    "faab",
    () => processFaabBids(),
    (r) => `processed=${r.length}`,
  );
  timings.push(faabTiming);

  const { result: tradeResults, timing: tradeTiming } = await timed(
    "trades",
    () => processDueTrades(),
    (r) => `processed=${r.length}`,
  );
  timings.push(tradeTiming);

  // Phase 7: lineup materialization — real today/yesterday dates, not the
  // rehearsal date. See file header for why.
  const lineupDate = yesterdayUTC();
  const materializeDates = Array.from(new Set([lineupDate, todayUTC()]));
  const { result: lineupResult, timing: lineupTiming } = await timed(
    "lineups",
    async () => {
      const teams = await prisma.team.findMany({ select: { id: true } });
      let materialized = 0;
      for (const team of teams) {
        for (const d of materializeDates) {
          await ensureLineupMaterialized(team.id, d);
          materialized++;
        }
      }
      return { teams: teams.length, materialized };
    },
    (r) => `teams=${r.teams} dates=${materializeDates.join(",")} materialized=${r.materialized}`,
  );
  timings.push(lineupTiming);

  // Phase 8: playoffs.
  const { timing: playoffsTiming } = await timed(
    "playoffs",
    () => processDuePlayoffs(),
    () => "done",
  );
  timings.push(playoffsTiming);

  const totalSeconds = (performance.now() - overallStart) / 1000;

  console.log("Phase breakdown:");
  for (const t of timings) {
    console.log(`  ${t.phase.padEnd(20)} ${t.seconds.toFixed(1).padStart(6)}s   ${t.detail}`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${totalSeconds.toFixed(1).padStart(6)}s`);

  const leaguesAfter = await prisma.league.count();
  const teamsAfter = await prisma.team.count();
  const rosterSlotsAfter = await prisma.rosterSlot.count();
  const statLinesAfter = await prisma.gameStatLine.count();

  console.log("\nRow counts (before -> after):");
  console.log(`  League:       ${leaguesBefore} -> ${leaguesAfter}`);
  console.log(`  Team:         ${teamsBefore} -> ${teamsAfter}`);
  console.log(`  RosterSlot:   ${rosterSlotsBefore} -> ${rosterSlotsAfter}`);
  console.log(`  GameStatLine: ${statLinesBefore} -> ${statLinesAfter}`);

  if (leaguesBefore !== leaguesAfter || teamsBefore !== teamsAfter || rosterSlotsBefore !== rosterSlotsAfter) {
    throw new Error(
      "League/Team/RosterSlot row count changed — the rehearsal is supposed to be read-only " +
        "with respect to leagues. Investigate before trusting this run.",
    );
  }

  console.log("");
  if (totalSeconds > HARD_BUDGET_SECONDS) {
    console.log(`❌ FAIL — ${totalSeconds.toFixed(1)}s exceeds the ${HARD_BUDGET_SECONDS}s hard Vercel limit.`);
  } else if (totalSeconds > SOFT_BUDGET_SECONDS) {
    console.log(
      `⚠️  OVER SOFT BUDGET — ${totalSeconds.toFixed(1)}s exceeds the ~${SOFT_BUDGET_SECONDS}s soft budget ` +
        `(still under the ${HARD_BUDGET_SECONDS}s hard limit, but with little headroom).`,
    );
    console.log(
      "STOP: per the plan, do not try to optimize this further here. Moving roster sync to its " +
        "own weekly cron or a queue is a scope decision for the user, not something to improvise.",
    );
  } else {
    console.log(`✅ PASS — ${totalSeconds.toFixed(1)}s, within the ~${SOFT_BUDGET_SECONDS}s soft budget.`);
  }

  console.log(`\nphaseErrors: waivers=${waiverResults.length} faab=${faabResults.length} trades=${tradeResults.length}`);
  console.log(`lineups materialized: ${lineupResult.materialized} across ${lineupResult.teams} teams`);
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
