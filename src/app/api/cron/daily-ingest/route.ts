import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ingestDate, yesterdayUTC } from "@/lib/ingest/daily";
import { syncTeamsRosters } from "@/lib/players/sync";
import { syncInjuryStatuses } from "@/lib/players/injuries";
import { processExpiredWaivers } from "@/lib/waivers/mutations";
import { processFaabBids } from "@/lib/faab/mutations";
import { processDueTrades } from "@/lib/trades/mutations";
import { processDuePlayoffs } from "@/lib/matchups/playoffs";
import { ensureLineupMaterialized } from "@/lib/lineups/mutations";
import { todayUTC } from "@/lib/dates";

// Vercel Hobby allows up to 60s per serverless function (default is much
// lower). The first production run of this route did a full 32-team roster
// sync sequentially and got killed mid-flight — 500 with no body, since the
// platform terminates the function rather than letting it finish. Scoping
// the sync to only teams that played (see ingestDate) plus this opt-in
// covers a realistic in-season day; if a day ever needs more than 60s,
// that's a sign the work needs to move off the request path entirely
// (e.g. a queue), not a bigger number here.
export const maxDuration = 60;

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

  const ingestResult = await phase("ingest", phaseErrors, () => ingestDate(date));
  const rosterResults = await phase("rosterSync", phaseErrors, () =>
    syncTeamsRosters(ingestResult?.teamsInvolved ?? []),
  );
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

  const rosterSynced = rosterResults?.reduce((s, r) => s + r.playersSynced, 0) ?? 0;
  const rosterFailed = rosterResults?.reduce((s, r) => s + r.failures.length, 0) ?? 0;

  return NextResponse.json({
    ok: phaseErrors.length === 0,
    phaseErrors,
    ingest: ingestResult,
    rosterSync: { teams: ingestResult?.teamsInvolved ?? [], synced: rosterSynced, failed: rosterFailed },
    injurySync: injuryResult,
    waivers: waiverResults,
    faab: faabResults,
    trades: tradeResults,
    lineups: lineupsResult,
  });
}
