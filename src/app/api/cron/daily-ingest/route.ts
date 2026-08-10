import { NextResponse } from "next/server";
import { ingestDate, yesterdayUTC } from "@/lib/ingest/daily";
import { syncAllRosters } from "@/lib/players/sync";

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
  const rosterResults = await syncAllRosters();

  const rosterSynced = rosterResults.reduce((s, r) => s + r.playersSynced, 0);
  const rosterFailed = rosterResults.reduce((s, r) => s + r.failures.length, 0);

  return NextResponse.json({
    ok: true,
    ingest: ingestResult,
    rosterSync: { synced: rosterSynced, failed: rosterFailed },
  });
}
