import { NextResponse } from "next/server";
import { ingestDate, yesterdayUTC } from "@/lib/ingest/daily";
import { syncTeamsRosters } from "@/lib/players/sync";
import { syncInjuryStatuses } from "@/lib/players/injuries";
import { processExpiredWaivers } from "@/lib/waivers/mutations";
import { processFaabBids } from "@/lib/faab/mutations";
import { processDueTrades } from "@/lib/trades/mutations";

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
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const date = yesterdayUTC();
  const ingestResult = await ingestDate(date);
  const rosterResults = await syncTeamsRosters(ingestResult.teamsInvolved);
  // Not scoped to teamsInvolved like the roster sync above — injuries aren't
  // tied to who played last night, so this checks every team every day. One
  // API call plus a handful of player lookups; cheap enough not to bother
  // scoping.
  const injuryResult = await syncInjuryStatuses();
  // Vercel Hobby allows only one cron trigger/day, so this is where "48
  // hours" (the demotion-waiver claim window) actually gets checked and
  // resolved — see src/lib/waivers/mutations.ts's file header.
  const waiverResults = await processExpiredWaivers();
  const faabResults = await processFaabBids();
  const tradeResults = await processDueTrades();

  const rosterSynced = rosterResults.reduce((s, r) => s + r.playersSynced, 0);
  const rosterFailed = rosterResults.reduce((s, r) => s + r.failures.length, 0);

  return NextResponse.json({
    ok: true,
    ingest: ingestResult,
    rosterSync: { teams: ingestResult.teamsInvolved, synced: rosterSynced, failed: rosterFailed },
    injurySync: injuryResult,
    waivers: waiverResults,
    faab: faabResults,
    trades: tradeResults,
  });
}
