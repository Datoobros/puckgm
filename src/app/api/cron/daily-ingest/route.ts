import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { healForwardDates, ingestRecentDates, yesterdayUTC } from "@/lib/ingest/daily";
import { syncTeamsRosters } from "@/lib/players/sync";
import { refreshCareerGp } from "@/lib/players/careerGp";
import { syncInjuryStatuses } from "@/lib/players/injuries";
import { processExpiredWaivers } from "@/lib/waivers/mutations";
import { processFaabBids } from "@/lib/faab/mutations";
import { processDueTrades } from "@/lib/trades/mutations";
import { processDuePlayoffs } from "@/lib/matchups/playoffs";
import { ensureLineupMaterialized } from "@/lib/lineups/mutations";
import { todayUTC } from "@/lib/dates";
import { pacerStats } from "@/lib/nhl/pacer";

// Vercel Hobby's real maxDuration ceiling is 300s, and 300 is also the
// platform default — the previous value here (60) traced to a stale Vercel
// changelog page, not current docs (re-confirmed for this batch; see
// plans/live-tracking-batch.md's "What Task 4b left behind"). The original
// concern this comment used to describe — a full 32-team roster sync
// getting killed mid-flight — is now handled by the shared pacer's circuit
// breaker (src/lib/nhl/pacer.ts) failing fast and reporting `rateLimited`
// instead of grinding past a real time budget. Do not lower this back to 60.
export const maxDuration = 300;

// Vercel's documented pattern: cron-triggered requests carry this header
// automatically. CRON_SECRET is a belt-and-suspenders check so the route
// can't be triggered by an arbitrary public GET — set it in Vercel project
// env vars and Vercel attaches it as a Bearer token automatically for cron
// invocations. See https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
interface PhaseError {
  phase: string;
  error: string;
}

// Every phase below runs through this instead of being awaited directly, so
// one phase throwing (the live case: getTeamRoster 429'd and killed the
// whole route — see src/lib/players/sync.ts) can no longer take the rest of
// the night's work with it. A failed phase is recorded and the route moves
// on; the response is still 200 either way, since a 500 tells Vercel to
// retry the *entire* run, which is worse than a partial success plus a
// recorded error.
async function phase<T>(
  name: string,
  phaseErrors: PhaseError[],
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    phaseErrors.push({ phase: name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const phaseErrors: PhaseError[] = [];
  const date = yesterdayUTC();

  // Created before any work runs, updated once at the end — a row that's
  // still finishedAt: null means the run was killed (e.g. Vercel's 60s
  // function limit) before it could get back here. That absence is the
  // signal; nothing else makes a mid-run death visible.
  const ingestRun = await prisma.ingestRun.create({
    data: { datesAttempted: healForwardDates() },
  });

  const ingestResult = await phase("ingest", phaseErrors, () => ingestRecentDates());
  const rosterOutcome = await phase("rosterSync", phaseErrors, () =>
    syncTeamsRosters(ingestResult?.teamsInvolved ?? []),
  );
  const rosterResults = rosterOutcome?.results ?? [];
  // The only landing-endpoint traffic left in the whole route (see
  // careerGp.ts) — bounded to a small nightly batch on purpose, so it runs
  // every night without reintroducing Task 4b's rate-limit problem.
  const careerGpResult = await phase("careerGp", phaseErrors, () => refreshCareerGp());
  // Not scoped to teamsInvolved like the roster sync above — injuries aren't
  // tied to who played last night, so this checks every team every day. One
  // API call plus a handful of player lookups; cheap enough not to bother
  // scoping.
  const injuryResult = await phase("injurySync", phaseErrors, () => syncInjuryStatuses());
  // Vercel Hobby allows only one cron trigger/day, so this is where "48
  // hours" (the demotion-waiver claim window) actually gets checked and
  // resolved — see src/lib/waivers/mutations.ts's file header.
  const waiverResults = await phase("waivers", phaseErrors, () => processExpiredWaivers());
  const faabResults = await phase("faab", phaseErrors, () => processFaabBids());
  const tradeResults = await phase("trades", phaseErrors, () => processDueTrades());

  // The persistent-lineup feature's primary write path — see
  // src/lib/lineups/mutations.ts's ensureLineupMaterialized doc comment.
  // Placed after the waiver/FAAB/trade processing above so anyone awarded
  // overnight lands in an open slot before anyone checks their team this
  // morning; page views are the fallback for any team nobody's cron missed.
  // Yesterday's included so one missed cron run heals itself the next
  // morning, same reliability model as ingestDate(yesterdayUTC()).
  const lineupsResult = await phase("lineups", phaseErrors, async () => {
    const teams = await prisma.team.findMany({ select: { id: true } });
    const materializeDates = Array.from(new Set([date, todayUTC()]));
    let materialized = 0;
    // Per-team/date try/catch — one team's bad data must not cost every
    // other team its lineup for the day.
    for (const team of teams) {
      for (const d of materializeDates) {
        try {
          await ensureLineupMaterialized(team.id, d);
          materialized++;
        } catch (e) {
          phaseErrors.push({
            phase: `lineups:${team.id}:${d}`,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    return { teams: teams.length, dates: materializeDates, materialized };
  });

  await phase("playoffs", phaseErrors, () => processDuePlayoffs());

  const rosterSynced = rosterResults.reduce((s, r) => s + r.playersSynced, 0);
  const rosterFailed = rosterResults.reduce((s, r) => s + r.failures.length, 0);
  const ok = phaseErrors.length === 0;

  // Which phases stopped early because a real 429 tripped the shared
  // pacer's circuit (src/lib/nhl/pacer.ts) — distinct from phaseErrors,
  // since a rate-limited stop is expected, honest partial progress, not a
  // bug. finalPacerStats is the raw counters behind it (requests issued,
  // 429s seen, whether the circuit is still open when this run finished).
  const rateLimitedPhases = [
    ingestResult?.rateLimited ? "ingest" : null,
    rosterOutcome?.rateLimited ? "rosterSync" : null,
    careerGpResult?.rateLimited ? "careerGp" : null,
  ].filter((p): p is string => p !== null);
  const finalPacerStats = pacerStats();

  await prisma.ingestRun.update({
    where: { id: ingestRun.id },
    data: {
      finishedAt: new Date(),
      gamesFound: ingestResult?.gamesFound ?? 0,
      gamesIngested: ingestResult?.gamesIngested ?? 0,
      gamesSkipped: ingestResult?.gamesSkipped ?? 0,
      statLinesWritten: ingestResult?.statLinesWritten ?? 0,
      phaseErrorsJson:
        phaseErrors.length > 0 ? (phaseErrors as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      ingestErrorsJson:
        ingestResult && ingestResult.errors.length > 0
          ? (ingestResult.errors as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      pacerStatsJson: finalPacerStats as unknown as Prisma.InputJsonValue,
      rateLimitedPhases,
      ok,
    },
  });

  return NextResponse.json({
    ok,
    ingestRunId: ingestRun.id,
    phaseErrors,
    pacerStats: finalPacerStats,
    rateLimitedPhases,
    ingest: ingestResult,
    rosterSync: {
      teams: ingestResult?.teamsInvolved ?? [],
      synced: rosterSynced,
      failed: rosterFailed,
      rateLimited: rosterOutcome?.rateLimited ?? false,
    },
    careerGp: careerGpResult,
    injurySync: injuryResult,
    waivers: waiverResults,
    faab: faabResults,
    trades: tradeResults,
    lineups: lineupsResult,
  });
}
