// One shared rate limiter + circuit breaker for every NHL API request in
// this process. Replaces ingest-reliability Task 1's retry-on-429, which was
// a design error for bulk work: a 3.5s backoff can't clear a *volume-based*
// limiter, the retry itself adds volume that keeps the limiter tripped, and
// every doomed request pays the full backoff before giving up. Measured
// consequence: careerGp spent ~50s to refresh 1-4 of 40 players (see
// plans/live-tracking-batch.md's "What Task 4b left behind"). Pacing up
// front and failing fast on a real 429 is the fix — see client.ts's
// pacedFetch, the only caller of acquire()/reportRateLimited() below.

const NHL_RATE = 4; // requests/second, shared across every caller in this process
const BURST = NHL_RATE; // small burst allowance — one second's worth, not more
const COOLDOWN_MS = 60_000;

export class NhlRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NhlRateLimitedError";
  }
}

// Refilled by elapsed wall-clock time rather than reset per request/per
// invocation: Vercel can reuse a warm instance across cron runs, and a
// reset-on-cold-start scheme would let a fresh burst slip through right
// after a warm gap instead of respecting the real rate over time.
let tokens = BURST;
let lastRefill = Date.now();

let circuitOpenUntil = 0;
let requestsIssued = 0;
let rateLimitedCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refill(): void {
  const now = Date.now();
  const elapsedSeconds = (now - lastRefill) / 1000;
  tokens = Math.min(BURST, tokens + elapsedSeconds * NHL_RATE);
  lastRefill = now;
}

/**
 * Await one token before making an NHL request. Rejects immediately with
 * NhlRateLimitedError if the circuit is open — no waiting, no retry, so a
 * tripped limiter turns into "stop this phase now and report it" instead of
 * "grind through the rest of the queue, each item paying full backoff."
 */
export async function acquire(): Promise<void> {
  if (Date.now() < circuitOpenUntil) {
    throw new NhlRateLimitedError("NHL API circuit open — rate limited recently, cooling down");
  }
  refill();
  while (tokens < 1) {
    const waitMs = ((1 - tokens) / NHL_RATE) * 1000;
    await sleep(Math.max(waitMs, 10));
    if (Date.now() < circuitOpenUntil) {
      throw new NhlRateLimitedError("NHL API circuit opened while waiting for a token");
    }
    refill();
  }
  tokens -= 1;
  requestsIssued += 1;
}

/**
 * Called by client.ts the moment a response actually comes back 429 — trips
 * the circuit for COOLDOWN_MS so every other in-flight or subsequent caller
 * fails fast instead of adding more load to a limiter that's already
 * tripped. A 3.5s backoff never cleared this in practice (see file header);
 * a minute of silence is what the NHL API's own behavior called for.
 */
export function reportRateLimited(): void {
  rateLimitedCount += 1;
  circuitOpenUntil = Date.now() + COOLDOWN_MS;
}

export function pacerStats(): {
  requestsIssued: number;
  rateLimitedCount: number;
  circuitOpen: boolean;
} {
  return {
    requestsIssued,
    rateLimitedCount,
    circuitOpen: Date.now() < circuitOpenUntil,
  };
}
