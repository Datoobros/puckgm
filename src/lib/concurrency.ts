// Shared by anything fanning out many small network calls (game ingestion,
// roster sync). Sequential loops over hundreds of NHL API calls are what
// blew the daily-ingest cron route past Vercel's function time limit — see
// git history on src/app/api/cron/daily-ingest/route.ts.
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
