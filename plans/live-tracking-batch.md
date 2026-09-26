# Plan — Live in-game stat tracking (Sept 2026)

Today a matchup score freezes at ~5am ET and doesn't move for 24 hours. This batch makes
scores tick during games, ESPN-style, and fixes the NHL-API rate-limit problem that
`plans/ingest-reliability-batch.md` Task 4b ran into — because both need the same piece of
infrastructure and building it twice would mean two limiters fighting over one budget.

Six tasks, in order, one commit each. Task 1 is foundational and also repairs Task 4b's
fallout; Tasks 2–4 are the feature; Task 5 wires the schedule; Task 6 retires the nightly
roster-metadata burst. Same working rules as the previous plans (`PROGRESS.md` first;
`npx tsc --noEmit` → `npm run build` → real browser verification via `preview_start
{name: "puckgm-dev"}`; exact-name test-data cleanup on the shared prod database; `// TEMP:`
auth bypasses reverted before commit and `grep -rn "TEMP:" src/` clean; commit messages
explain *why*). Per `AGENTS.md`, this repo runs **Next 16.3.0** with its own bundled docs at
`node_modules/next/dist/docs/` — read the relevant guide before touching route handlers or
caching.

**Kickoff prompt for an implementing session:**
> Read `PROGRESS.md`, then `plans/live-tracking-batch.md`. Implement **Task N** only,
> exactly as specified — the design decisions are already made. Verify per the task's
> Verification section, add a short section to PROGRESS.md, tick the task's checklist in
> the plan, commit (don't push).

---

## Decisions already made (confirmed with the user 2026-09-26 — don't re-open)

1. **Poll every 60 seconds.**
2. **Live points fold into the matchup score with a LIVE badge** — ESPN's single-number
   treatment, not a separate column.
3. **Display only.** Matchup results, standings, and playoff seeding settle on **finalized
   data only**. Live numbers are never authoritative.
4. **Live points count only non-bench lineup slots** for that date, matching what
   `src/lib/matchups/standings.ts` already does (`lineupSlot: { not: "BE" }`). Otherwise
   live and official would disagree about who is even playing.
5. **Raw stats stored, points computed on read** — same rule as `GameStatLine`
   (DESIGN.md §4.1). One snapshot serves every league, because each league's
   `scoringConfig` is applied at read time by the existing `computeFantasyPoints`.

---

## Verified against the real NHL API during live games (2026-09-26 — don't rediscover)

Checked against game `2026010053` (CAR@NSH) while it was in the 3rd period:

- **The live boxscore is fully populated mid-game.** Identical stat keys to the final
  payload: `goals, assists, sog, hits, blockedShots, pim, plusMinus, takeaways, giveaways,
  powerPlayGoals, points, shifts, toi, position, sweaterNumber`. Nothing is withheld
  until the end.
- **Data is ~20 seconds fresh.** Response carries `cache-control: max-age=19, s-maxage=19`.
  Polling faster than ~30s returns cached bytes; 60s is effectively real-time.
- **It really does move.** Three samples 45s apart: clock 14:52 → 13:49 → 12:54, total TOI
  15,829 → 16,237 → 16,527 seconds, and a shot landed between samples 2 and 3.
- **Bonus context available:** a `clock` object (`timeRemaining`, `secondsRemaining`,
  `running`, `inIntermission`) and `periodDescriptor` (`number`, `periodType`). Enough to
  render "3rd · 14:52" and "INT".
- **`decision` (W/L/O) is absent mid-game** and appears only at final. **Goalie win points
  therefore cannot score live** — they pop in when the game finalizes. This must be visible
  in the UI, not hidden.
- **Schema drifts by game state:** live goalie lines carry `savePctg` but no `starter`;
  final lines carry `starter` but no `savePctg`. Do not assume one shape.
- **Game states seen:** `FUT` → `PRE` → `LIVE` → `CRIT` (late-and-close) → `OFF`. Treat
  both `LIVE` and `CRIT` as in-progress. Preseason is `gameType` 1 and stays excluded from
  everything here.

## What Task 4b left behind (the reason Task 1 exists)

Task 4b cut `rosterSync` from 120.3s to 12–15s and fixed the ~800-players-silently-skipped
bug, but the full dress rehearsal still came in at ~103s, and **half of that was one phase
failing**:

| phase | time | outcome |
|---|---|---|
| ingest | ~26s | fine |
| lineups | ~14s | fine |
| rosterSync | 13s | 698–762 of ~950 players, 6–8 roster fetches 429'd |
| **careerGp** | **50s** | **refreshed 1–4 of 40** |

The root cause is a design error in `plans/ingest-reliability-batch.md` Task 1:
**retry-on-429 is counterproductive for bulk work.** Retry is correct for a one-off
transient blip. In a fan-out it is actively harmful — a 3.5s backoff is not long enough to
clear a volume-based limiter, the retry itself adds volume and keeps the limiter tripped,
and every doomed request costs the full backoff. `careerGp`'s 50 seconds is almost entirely
paid-for failure, not work.

A full cron run needs roughly **106 NHL requests** (3 schedule + ~30 boxscores + 32 rosters
+ 1 injury + 40 careerGp). Paced at 3–4/second that is ~30 seconds with **nothing
throttled**. The answer is to pace globally, not to retry.

---

## Task 1 — One shared NHL request pacer, replacing retry-on-429

Foundational. Everything else in this batch depends on it, and it repairs Task 4b.

### Changes

`src/lib/nhl/pacer.ts` (new)
- A module-level token-bucket limiter shared by **every** NHL request in a process:
  `NHL_RATE = 4` requests/second, small burst allowance. All callers await a token before
  fetching. Because Vercel may reuse a warm instance across invocations, the bucket refills
  on wall-clock time rather than resetting per request.
- A **circuit breaker**: on a 429, open the circuit for `COOLDOWN_MS = 60_000` and have
  every subsequent `acquire()` reject immediately with a distinguishable
  `NhlRateLimitedError` instead of waiting. This converts "grind through 36 doomed retries"
  into "skip the rest of this phase and report it."
- Export a `pacerStats()` returning requests issued, 429s seen, and whether the circuit is
  open, so callers can report honestly.

`src/lib/nhl/client.ts`
- Every request goes through the pacer. **Remove 429 from `fetchWithRetry`'s retryable
  set** — keep retry for `5xx` only, which is a genuine transient. Comment the reasoning
  (ingest-reliability Task 1 got this wrong; this is the correction) so it doesn't get
  reverted as an apparent regression.
- `NhlRateLimitedError` must propagate, not be swallowed as a generic failure.

`src/lib/players/careerGp.ts`, `src/lib/players/sync.ts`, `src/lib/ingest/daily.ts`
- On `NhlRateLimitedError`, **stop the fan-out immediately** and return partial results with
  a `rateLimited: true` flag. Do not treat it as a per-item failure. Remaining items are
  simply not attempted this run — the next run picks them up.

`src/app/api/cron/daily-ingest/route.ts`
- **`maxDuration = 60` → `300`.** Hobby's real ceiling is 300s and 300s is also the default;
  the 60 traces to a stale Vercel changelog. Comment this so nobody "fixes" it back.
- Include `pacerStats()` and each phase's `rateLimited` flag in the response and in the
  `IngestRun` row.

### Verification

- `npx tsc --noEmit`, `npm run build`.
- **Re-run `scripts/ingest-dress-rehearsal.ts 2025-10-11`.** Targets: `careerGp` refreshes
  close to 40/40 rather than 1–4, `rosterFetchFailed` is **0**, `playersSeen` ≈ 950, and the
  TOTAL is under 60s. Record the per-phase table verbatim.
- Prove the circuit breaker: temporarily set `NHL_RATE` high enough to trip the limiter on
  purpose, confirm the run **fails fast with `rateLimited: true`** instead of grinding, and
  that the phase returns partial results rather than throwing. Revert.
- Confirm a `5xx` still retries and a `404` still means "no games" (`getDaySchedule`).
- Row counts unchanged: League 9, Team 22, RosterSlot 180, GameStatLine 52,478.
- Space out repeat runs — the limiter stays tripped for minutes. Blanket 429s mean your own
  test traffic, not broken code.

### Checklist
- [x] `pacer.ts` token bucket + circuit breaker + `pacerStats()`
- [x] All NHL requests paced; 429 removed from retryable, 5xx kept, reasoning commented
- [x] Fan-outs stop on `NhlRateLimitedError` and report `rateLimited`
- [x] `maxDuration` 300, with a comment on why 60 was wrong
- [ ] Dress rehearsal: careerGp ≈40/40, rosterFetchFailed 0, playersSeen ≈950, TOTAL <60s —
      TOTAL (43.6–45.4s) and rosterFetchFailed (0) hold across three real runs; careerGp/
      playersSeen didn't reach ≈40/40 / ≈950 because a real 429 tripped the circuit at almost
      the same point in all three attempts (5/6/10 min apart) — session-cumulative live-API
      pressure, not a code defect. See PROGRESS.md's Task 1 write-up.
- [x] Circuit breaker proven to fail fast, not grind (deterministic mock proof + live proof)
- [x] 5xx retry and 404 handling intact
- [x] Row counts unchanged
- [x] PROGRESS.md section + commit

---

## Task 2 — `LiveGameSnapshot` store + the poller

### Storage decision, and a revision

An earlier conversation said provisional stats should go in a cache (Upstash/KV) rather than
Postgres, to protect Neon's free tier. **Revised after doing the arithmetic: use Postgres.**

- Neon free is 100 CU-hours/month with auto-suspend after 5 min. A 6-hour game window on
  ~25 nights/month is ~150 hours awake, but **the database is already awake during those
  windows** — that is exactly when managers are loading pages. The marginal cost of the
  poller is near zero, and at Neon's 0.25 CU floor even the full 150 hours is ~37 CU-hours.
- Storage is a non-issue: the DB is 49 MB against a 512 MB cap.
- The upside is large: no new vendor, no second free tier to monitor, no cache-miss
  fallback path, and the data is queryable from the Server Components that already use
  Prisma.
- **Fallback if Neon compute ever becomes the binding constraint:** move this one table to
  a cache. Nothing else in the design changes, which is why it's safe to start here.

**One row per game, not per player.** 16 games × ~40 players would be ~640 upserts every 60
seconds (~230k/night) — far too many. One JSON row per game is 16 writes/minute, and the
read path loads ≤16 rows and indexes them in memory.

### Changes

`prisma/schema.prisma`:

```prisma
model LiveGameSnapshot {
  gameId       String   @id
  gameDate     DateTime
  gameState    String            // LIVE | CRIT | OFF-pending-ingest
  periodNumber Int?
  periodType   String?
  clockRemaining String?
  clockRunning Boolean  @default(false)
  inIntermission Boolean @default(false)
  awayAbbrev   String
  homeAbbrev   String
  awayScore    Int      @default(0)
  homeScore    Int      @default(0)
  playersJson  Json              // [{ nhlPlayerId, playerId, ...rawStats }] mirroring
                                 // GameStatLine.statsJson so computeFantasyPoints works
                                 // unchanged
  fetchedAt    DateTime @updatedAt

  @@index([gameDate])
}
```

Migration: `add_live_game_snapshot`.

`src/lib/live/poll.ts` (new)
- `pollLiveGames()`: one `getDaySchedule(todayUTC())` call; filter to `gameType` 2 (and 3,
  matching ingest-reliability Task 5) in `LIVE`/`CRIT`. **If none, return immediately** —
  this early exit is what makes a year-round 60s schedule nearly free.
- For each live game, fetch the boxscore through the pacer, map each player to an internal
  `playerId` via the existing `ensurePlayerStub`, strip `playerId`/`name` out of the stored
  payload exactly as `ingestGame` does, and upsert one `LiveGameSnapshot`.
- Store `clock` and `periodDescriptor` fields for the UI.
- On `NhlRateLimitedError`, stop and report — a skipped poll is harmless, the next one is 60
  seconds away.

`src/app/api/cron/live-poll/route.ts` (new)
- Same `CRON_SECRET` bearer check as the daily route. `maxDuration = 60`.
- Never throws; always 200 with `{ ok, gamesPolled, snapshotsWritten, rateLimited,
  pacerStats }`.
- **Deliberately separate from the daily ingest route.** Different cadence, different
  failure tolerance, and the daily route is the authoritative path — it must not be
  entangled with a best-effort one.

`src/lib/live/read.ts` (new)
- `getLiveStatsForPlayers(playerIds, date)`: loads today's snapshots, returns a
  `Map<playerId, rawStats>` plus per-game live context (period, clock, state).
- No points computed here — callers apply their league's config via `computeFantasyPoints`,
  per decision #5.

### Verification

- `npx prisma migrate dev --name add_live_game_snapshot`, `npx tsc --noEmit`, `npm run build`.
- **Run it against real live games.** NHL games run most evenings; confirm snapshots are
  written for every `LIVE`/`CRIT` game, and that a second run 60s later shows **changed**
  TOI/clock — that's the proof it's live and not a one-off fetch.
- Spot-check one snapshot's `playersJson` against
  `api-web.nhle.com/v1/gamecenter/{id}/boxscore` field by field.
- Confirm the early exit: run when nothing is live, expect `gamesPolled: 0` and a sub-second
  response.
- Confirm preseason (`gameType` 1) is never snapshotted.
- Confirm `GameStatLine` is untouched — **52,478 rows before and after.** The poller must
  never write to the authoritative table (Task 3 handles finalization).
- Wrong bearer token → 401, no snapshot written.

### Checklist
- [ ] `LiveGameSnapshot` model + migration
- [ ] `pollLiveGames` with early exit, pacer-routed fetches, one row per game
- [ ] `/api/cron/live-poll` route, bearer-checked, never throws
- [ ] `getLiveStatsForPlayers` returns raw stats, not points
- [ ] Verified against real live games, including change across two polls 60s apart
- [ ] Preseason excluded; `GameStatLine` still 52,478
- [ ] 401 path writes nothing
- [ ] PROGRESS.md section + commit

---

## Task 3 — Finalize on `OFF`, and retire the stale-overnight window

The quiet win. A poller already watching game states can ingest a game the moment it
finalizes — that is final data, so it legitimately belongs in the authoritative path.

### Changes

`src/lib/live/poll.ts`
- Widen the schedule filter to also pick up games in `OFF` that have **no `GameStatLine`
  rows yet**. For those, call the existing `ingestGame(gameId)` — unchanged, still
  `OFF`-only, still idempotent — and on success **delete that game's `LiveGameSnapshot`**,
  so the read path naturally falls back to the authoritative rows.
- Order matters: finalize first, then snapshot the still-live games. A game must never be
  simultaneously ingested and snapshotted.

`src/app/api/cron/daily-ingest/route.ts`
- Comment that the daily run is now a **safety net**, not the primary path: the live poller
  normally ingests each game within a minute of finalizing, and the heal-forward window
  catches anything the poller missed.

`plans/ingest-reliability-batch.md`
- Mark **defect #4** (a late-finalizing West Coast game skipped by the 5am cron and never
  retried) as resolved here, cross-referencing this task.

### Verification

- End to end on a real game: snapshot it while `LIVE`, wait for `OFF`, run the poller, and
  confirm (a) `GameStatLine` rows appear for that `gameId`, (b) the `LiveGameSnapshot` row
  is gone, (c) the row count rose by exactly that game's player count.
- Confirm idempotency: run the poller again immediately and confirm no duplicate rows and no
  error (the game now has stat lines, so it's skipped).
- Confirm a game still `LIVE` is **not** ingested.
- Confirm the daily cron still works standalone with the poller switched off — it must remain
  a complete fallback, not a dependent.

### Checklist
- [ ] Poller finalizes `OFF` games with no stat lines, via unchanged `ingestGame`
- [ ] Snapshot deleted on successful finalize; finalize ordered before snapshotting
- [ ] Verified on a real game across the LIVE → OFF transition
- [ ] Idempotent on re-run; `LIVE` games never ingested
- [ ] Daily cron still complete on its own
- [ ] ingest-reliability defect #4 marked resolved
- [ ] PROGRESS.md section + commit

---

## Task 4 — UI: LIVE badge and provisional points

The visible half. Decision #2 (folded into the score) plus decision #3 (display only) create
a real tension — a number that's in the score but doesn't settle the result. **The labelling
is what resolves it, so it is not optional polish.**

### Changes

`src/lib/matchups/standings.ts`
- New `getTeamScoreWithLive(teamId, period)` alongside the existing function. It returns
  `{ finalPoints, livePoints, hasLive }`. **Leave `getTeamScoreForPeriod` untouched** — it
  is what decides results and standings, and per decision #3 it must keep seeing finalized
  data only. A comment must say so explicitly, next to both functions.
- Live points use the same non-bench `LineupEntry` filter as the final path (decision #4).

New `src/components/LiveBadge.tsx`
- Renders `LIVE · 3rd 14:52`, or `INT` during an intermission, from the snapshot's clock
  fields. Accessible (not colour-only) and legible in the app's light theme.

Scoreboard (`src/app/leagues/[id]/scoreboard/page.tsx`) and matchup detail
(`src/app/leagues/[id]/matchups/[matchupId]/page.tsx`)
- Show the combined number with the `LiveBadge` when `hasLive`, and a plain final number
  otherwise. Where a matchup is partly settled, say so in words — e.g. "3 of 8 games final"
  — rather than leaving an ambiguous total.
- The matchup detail page marks each **player row** as live/final so a manager can see which
  of their players are still accruing.

Team page (`src/app/leagues/[id]/teams/[teamId]/page.tsx`)
- Per-player live indicator in the Skaters/Goalies tables, reusing `LiveBadge`.
- **Goalies need an explicit note** that win points land when the game ends, since
  `decision` doesn't exist mid-game. A tooltip or a short line under the goalie table —
  labelled, not silently missing.

### Verification

- Real browser, against **real live games** (`preview_start {name: "puckgm-dev"}`): a
  manager with a live player sees the badge, the period/clock, and a total that increases
  across a refresh 60+ seconds later.
- **The correctness check that matters: standings must not move during a live game.** Load
  standings mid-game, confirm the numbers match what they were before the game started, and
  that only the scoreboard/matchup/team views show the live total.
- Verify the partly-settled wording on a matchup with some games final and some live.
- Verify the goalie note renders, and that a goalie's total jumps by the configured `wins`
  value once the game finalizes.
- Mobile width and light theme both legible.

### Checklist
- [ ] `getTeamScoreWithLive` added; `getTeamScoreForPeriod` untouched and commented
- [ ] `LiveBadge` with period/clock/intermission, not colour-only
- [ ] Scoreboard + matchup detail show combined total, badge, and partly-settled wording
- [ ] Matchup detail marks per-player live/final
- [ ] Team page per-player indicator + explicit goalie-win note
- [ ] Standings provably unchanged mid-game
- [ ] Verified against real live games in a real browser; mobile checked
- [ ] PROGRESS.md section + commit

---

## Task 5 — Scheduling, free, plus a usage guard

Vercel Hobby caps its **own scheduler** at once per day. That limit does not apply to the
route, which is an ordinary HTTP GET behind `CRON_SECRET`, so an external scheduler drives
it at no cost. **Vercel Pro is not required for this feature.**

### Changes

**Correction (2026-09-26): GitHub Actions cannot do this, and an earlier draft of this plan
wrongly said it could.** GitHub's own docs are explicit: *"The shortest interval you can run
scheduled workflows is once every 5 minutes"*, queued jobs *"may be dropped"* under load, and
**in a public repository scheduled workflows are automatically disabled after 60 days with no
repository activity** — which would silently kill live scoring over an offseason. A `*/1`
schedule is not available at any price on Actions. Use a dedicated scheduler instead.

**Primary: a dedicated free cron service** (cron-job.org, or Upstash QStash)
- One HTTP GET to the production `/api/cron/live-poll` every 60 seconds, `Authorization:
  Bearer <CRON_SECRET>`. **No repository change at all** — this is configured in the
  service's own UI.
- Prefer a service that emails on repeated non-200s, so a silent scheduler death is visible.
- The token lives with that third party. That is the one real trade-off versus Actions, and
  it is acceptable because the token only grants the right to trigger a read-only poll — it
  is not a database or Clerk credential. Keep it distinct from anything else if possible.

**Fallback if a third-party scheduler is unacceptable: self-looping on a 5-minute trigger**
- A GitHub Actions workflow on `*/5 * * * *` (the real minimum) triggers the route, and the
  route itself loops internally — poll, wait 60s, repeat — for up to 5 polls before
  returning, using the `maxDuration = 300` that Task 1 established. Effective 60s freshness
  from a 5-minute trigger.
- **Cost note, because this changes the billing shape:** provisioned memory is billed for a
  *running* instance, so a function held open 300s costs far more memory-time than five
  short ones. Confined to game windows (~6h × ~25 nights ≈ 150 hours/month) it still fits
  Hobby's 360 GB-hrs, but it must early-exit instantly outside those windows or it will not.
  The stateless every-60s option is cheaper on every metric; this exists only to avoid a
  third party.
- If this route is taken, the workflow file must document the drop-under-load and 60-day
  auto-disable behaviour, and something must re-enable it after an offseason.

`src/lib/live/poll.ts`
- **Hard usage guard.** Refuse to do work outside a plausible game window and bail instantly
  when nothing is live. The early exit must stay genuinely cheap — this is the difference
  between ~1 CPU-hour/month and burning the Hobby allowance.

`docs/` or `PROGRESS.md`
- Record the projected usage and where to watch it: ~44,000 invocations/month worst case
  against Hobby's 1,000,000; ~1 CPU-hour against 4 included. **And the important caveat:
  exceeding Hobby's included usage *pauses* the feature for 30 days rather than billing an
  overage.** So the failure mode is downtime, not a surprise charge — which is the real
  reason to keep the early exit cheap and to watch Vercel's usage dashboard through the
  first month of the season.

### Verification

- Trigger the scheduler manually (its UI's "run now", or `workflow_dispatch` on the fallback)
  and confirm a 200 plus a snapshot
  written during live games.
- Confirm the bearer token is a repository **secret**, never committed, and that a bad token
  gets a 401.
- Confirm the early exit costs a sub-second response when nothing is live.
- After ~24h of real scheduling, read Vercel's usage dashboard and record actual invocations
  and Active CPU in PROGRESS.md — projections are not measurements.

### Checklist
- [ ] 60s schedule via a dedicated cron service (NOT GitHub Actions — 5-min minimum), token
      held as a secret, alerting on repeated non-200s
- [ ] If the self-looping fallback is used instead: 5-min trigger, in-route loop, early exit
      verified, and the drop-under-load + 60-day auto-disable caveats documented
- [ ] Early exit cheap and guarded; verified sub-second when idle
- [ ] Usage projection + the "Hobby pauses, doesn't bill" caveat recorded
- [ ] Real measured usage recorded after ~24h
- [ ] PROGRESS.md section + commit

---

## Task 6 — Move roster metadata and `careerGp` onto the trickle

With a poller running every minute, background refreshes no longer need to be a nightly
burst competing with ingest for one rate-limit budget.

### Changes

`src/lib/live/poll.ts`
- After live work, if the pacer has budget left and the circuit is closed, spend it on a
  **small** background slice: `refreshCareerGp(2)` and one team's roster sync, rotating
  through teams across invocations. Persist the rotation cursor (a tiny table or a reused
  settings row — don't rely on warm-instance memory).
- Live work always takes priority. Background work is strictly best-effort and must never
  delay or displace a snapshot.

`src/app/api/cron/daily-ingest/route.ts`
- Reduce the nightly `refreshCareerGp` limit now that the trickle carries most of it, and
  keep the nightly roster sync as a **weekly-style catch-up** for teams the rotation missed.
  The nightly run stays a complete fallback if the poller is off — same philosophy as Task 3.

### Verification

- Confirm the trickle advances: run the poller several times and show the rotation cursor
  moving and different teams being synced.
- Confirm live work is never starved — snapshots still written on every poll with games
  live, background work skipped when the circuit is open.
- Re-run the dress rehearsal and confirm the nightly TOTAL drops further and stays under 60s.
- Confirm full roster coverage is still achieved within a rotation cycle (all 32 teams).

### Checklist
- [ ] Background slice after live work, priority-ordered, persisted rotation cursor
- [ ] Live snapshots never delayed or skipped for background work
- [ ] Nightly limits reduced; nightly run still a complete fallback
- [ ] Rotation demonstrably covers all 32 teams
- [ ] Dress rehearsal TOTAL under 60s
- [ ] PROGRESS.md section + commit

---

## Explicitly out of scope

- **Live points affecting results, standings, or playoff seeding.** Decision #3. If this is
  ever revisited, note that NHL scorers reassign assists days later, so a settled result
  could retroactively flip — which is exactly what DESIGN.md §4.1's compute-on-read rule
  exists to prevent.
- **True PPP / SHP.** The boxscore has no power-play assists and no shorthanded goals, live
  or final. Needs a play-by-play feed.
- **Goalie wins mid-game.** Impossible — `decision` doesn't exist until final. Labelled in
  Task 4 rather than faked.
- **Play-by-play, shift charts, scoring plays, or a game-feed UI.** Different endpoints,
  different feature.
- **Push notifications on scoring plays.** Tempting once snapshots exist; its own product
  decision.
- **Vercel Pro.** Not required. Two legitimate reasons to buy it anyway, neither about this
  feature: native per-minute cron (no external scheduler to maintain), and it removes
  Hobby's pause-on-overage cliff by billing overages instead. It also bundles a free
  first-year domain, which the project needs eventually for a **Clerk Production** instance
  (Clerk verifies production via DNS — see PROGRESS.md's Live section).
