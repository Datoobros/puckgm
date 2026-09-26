# Plan — Ingest reliability + stat coverage (Sept 2026)

The 2026-27 NHL regular season starts **2026-09-29**. The daily ingest cron has existed
since the first commit but has **never once ingested a real game** — every one of the
52,478 `GameStatLine` rows was written in August 2026 by `scripts/backfill-season.ts`,
because this project started (2026-08-09) after the 2025-26 season ended (2026-04-16).
Opening night is the pipeline's first real test, and today it has three ways to lose data
silently and one way to abort the entire nightly run.

This batch hardens the ingest path and closes the stat-coverage gaps found in the same
review. **It does not build live/in-game tracking** — that needs Vercel Pro plus a
separate provisional-stats store, and gets its own plan (see "Explicitly out of scope").

Seven tasks, in order, one commit each. Tasks 1–4 are the ones that must land before
2026-09-29; 5–7 can follow. Same working rules as the previous plans (`PROGRESS.md`
first; `npx tsc --noEmit` → `npm run build` → real browser verification via
`preview_start {name: "puckgm-dev"}`; exact-name test-data cleanup on the shared prod
database; `// TEMP:` auth bypasses reverted before commit and `grep -rn "TEMP:" src/`
clean; commit messages explain *why*). Per `AGENTS.md`, this repo runs **Next 16.3.0** with
its own bundled docs at `node_modules/next/dist/docs/` — read the relevant guide before
touching route-handler or caching behaviour (Task 2 and Task 3 both edit a route handler).

**Kickoff prompt for an implementing session:**
> Read `PROGRESS.md`, then `plans/ingest-reliability-batch.md`. Implement **Task N** only,
> exactly as specified — the design decisions are already made. Verify per the task's
> Verification section, add a short section to PROGRESS.md, tick the task's checklist in
> the plan, commit (don't push).

---

## What exists already (verified against the live DB and the real NHL API, 2026-09-26 — don't rediscover)

**The cron is alive and healthy.** `vercel.json` → `0 9 * * *` → `/api/cron/daily-ingest`.
It ran on 2026-09-25 at 09:42 UTC and the injury sync wrote 9 players (Marchand, Demko,
Huberdeau → IR). Auth (`CRON_SECRET` bearer check), team-scoped roster sync, and the
August `maxDuration = 60` fix all work.

**Ingestion is final-games-only, by design.** `ingestGame` (`src/lib/ingest/games.ts:32`)
returns `skipped-not-final` unless `gameState === "OFF"`; `ingestDate`
(`src/lib/ingest/daily.ts:33`) pre-filters the same way plus `gameType !== 2`.
Nothing persists fantasy points (DESIGN.md §4.1) — matchup scores read `GameStatLine`
through `computeFantasyPoints` at read time. The only `setInterval` in the app is the
draft room's; nothing polls for game data.

**Stat capture is complete and exact.** `ingestGame` stores the boxscore player payload
**verbatim** minus `playerId`/`name` — a raw-vs-stored key diff on game 2025021312 came
back identical. Stored skater keys: `assists, blockedShots, faceoffWinningPctg,
giveaways, goals, hits, pim, plusMinus, points, position, powerPlayGoals, shifts, sog,
sweaterNumber, takeaways, toi`. Goalie keys include `decision` (on the 2,624 lines that
earned one = 1,312 games × 2), `saves`, `shotsAgainst`, `goalsAgainst`, and the
even/PP/SH splits.

Verified against NHL's own numbers for the 2025-26 hits leaders
(`api.nhle.com/stats/rest/en/skater/realtime`) — **exact match on all four**:

| Player | puckgm GP/H/BLK/TK/GV | NHL official |
|---|---|---|
| Yakov Trenin | 82 / 413 / 39 / 24 / 63 | 82 / 413 / 39 / 24 / 63 |
| Kiefer Sherwood | 72 / 339 / 30 / 26 / 76 | 72 / 339 / 30 / 26 / 76 |
| Will Cuylle | 82 / 302 / 68 / 9 / 56 | 82 / 302 / 68 / 9 / 56 |

GP/SOG/G/A/PIM also match the landing endpoint exactly, including Sherwood's mid-season
trade (44+28 GP, 109+63 SOG, 17+6 G, 6+7 A, 22+28 PIM across two team rows).

**So hits and blocks are tracked perfectly — they just score nothing.** `HIT` and `BLK`
are already columns in `SKATER_COLUMNS` (`src/lib/players/columns.ts`) and already scored
by `computeFantasyPoints`. But `STARTER_SCORING` sets `hits: 0` and `blockedShots: 0`, and
**all 9 leagues in the database — including the real "Experimenting" league — carry those
zeros.** That's a config value, changeable today in the commissioner's Adjust Scoring UI,
not a code gap. Task 7 covers the default.

**8 of the 9 leagues are leftover test leagues** ("Draft Test League (delete…)", four
"QoL Batch Test League (delete…)", etc.) sitting on the shared prod database. They cost
real cron time in the lineup-materialization loop. Task 6.

**The manual recovery path works.** `npx tsx --env-file=.env scripts/backfill-season.ts
20262027` is idempotent (`GameStatLine` is unique on `(playerId, gameId)`) and already
uses `runWithConcurrency(…, 10, …)`. Note the contrast with `ingestDate`, which loops
games **sequentially**.

---

## The defects this batch fixes (all reproduced, not inferred)

1. **A failed run is permanent, silent data loss.** `ingestDate(yesterdayUTC())` processes
   exactly one day and never looks back. Nothing reads the `errors` array it returns. One
   bad run = those games missing forever until someone notices a wrong matchup score and
   runs the backfill by hand. Compare `ensureLineupMaterialized`, which deliberately does
   yesterday *and* today so "one missed cron run heals itself the next morning" — ingestion
   has no such guard.

2. **One uncaught throw kills the whole nightly run.** `getTeamRoster` at
   `src/lib/players/sync.ts:24` sits *outside* the try/catch that protects per-player
   fetches. **Reproduced live**: the NHL API returned `429` for `/roster/STL/current` and
   the exception propagated out of `syncTeamRoster` → `syncRosters` → `syncTeamsRosters` →
   the route handler. Everything downstream — injury sync, waivers, FAAB, trades, lineup
   materialization, playoffs — silently never runs. `getJson`
   (`src/lib/nhl/client.ts:9`) has **no retry or backoff anywhere**, and `getDaySchedule`
   only special-cases 404, so a 429 on the very first call aborts before anything happens.

3. **A full slate may exceed the 60s function limit.** `ingestDate("2025-10-11")` (16
   games) measured **75.4s** from a local machine, before any roster/injury/waiver/FAAB/
   trade/lineup work. Vercel→Neon round trips will be much faster than home→Neon, so this
   is not proof it will time out — but the cause is structural (sequential game loop,
   ~640 sequential upserts) and the fix is cheap.

4. **Late games can slip through and never come back.** A West Coast game still in
   `FINAL` rather than `OFF` at 09:00 UTC (≈5am ET) is skipped — and per #1, never retried.

5. **NHL playoff games never ingest at all.** `gameType !== 2` skips type 3. A league's
   fantasy playoff bracket runs in April against real NHL playoff games; every one of
   those matchups would score **zero** for every team.

6. **The two scoring paths disagree on takeaways and giveaways.**
   `computeFantasyPoints` (per-game) scores them. `computeFantasyPointsFromTotals`
   (aggregate) **omits them entirely**, because the `getPlayerStatsAggregate` SQL
   (`src/lib/players/rankings.ts:90-100`) sums 11 stats and not those two. Both keys are
   exposed as editable in `EDITABLE_SCORING_FIELDS`, so a commissioner can set
   `takeaways: 1` and get matchup scores that don't match the Players page, the draft
   autopick ranking, auto-set lineup, trade review, standings season stats, or the player
   profile modal — 12 call sites feed off the aggregate path. This is exactly the
   "silently does nothing" control the engine's own comment says the app avoids.

7. **`powerPlayGoals` is captured but unscorable.** It's in every stored skater line and
   in no `ScoringConfig` field. Free win.

---

## Decisions already made (don't re-open)

- **Heal-forward window is 3 days.** Covers a missed run, a late-finalizing game, and a
  transient NHL API outage, without re-walking the season every night. Re-ingest is a
  cheap idempotent upsert, so overlap is harmless.
- **`OFF` stays the only ingestable state.** Do *not* start accepting `FINAL` — `OFF`
  means NHL has finalized the stats, and the heal-forward window is the correct fix for
  slow finalization. This also preserves DESIGN.md §4.1's guarantee.
- **The cron route never throws.** Every phase is independently wrapped; the route always
  returns 200 with a per-phase status object. A phase that fails must not stop the next
  one. (Waivers/FAAB/trades are time-sensitive — they cannot be collateral damage from an
  NHL API hiccup.)
- **Failures become visible in the database, not just in a JSON response nobody reads.**
  New `IngestRun` row per cron execution. This is the difference between "quietly wrong
  scoreboard" and "I can see what happened."
- **Retry policy: 3 attempts, 500ms → 1s → 2s, on 429 and 5xx only.** 404 keeps its
  current meaning (no schedule published / no such resource). Retrying a 404 is pointless.
- **Playoff games ingest as `gameType` 2 *and* 3.** `GameStatLine` gains no new column —
  the existing `gameId` already encodes game type in its 6th digit if anything ever needs
  to distinguish them. Fantasy leagues score NHL playoff games like any other.
- **Do not change existing leagues' scoring configs in code.** `STARTER_SCORING` is the
  default for *new* leagues; changing a live league is the commissioner's call through the
  Adjust Scoring UI (which already writes a settings-change history row). Task 7 changes
  the default only, and says so in the UI.
- **PPP/SHP stay unsupported and stay out of `EDITABLE_SCORING_FIELDS`.** The boxscore has
  no power-play *assists*; true PPP needs a play-by-play feed. Unchanged by this batch.

---

## Task 1 — Retry/backoff in the NHL client, concurrency in `ingestDate`

Fixes defects #2 (partly), #3.

### Changes

`src/lib/nhl/client.ts`
- Add a module-private `fetchWithRetry(url, attempts = 3)` used by `getJson`. Retry only
  on `429` and `5xx`; back off 500ms → 1s → 2s (plain `setTimeout`, no dependency). Honour
  a `Retry-After` header when present and ≤ 5s, otherwise use the backoff. On final
  failure throw the same `NHL API ${status} for ${url}` message as today, so existing
  error-message assertions and log greps keep working.
- Same treatment for `SEARCH_BASE` calls (they go through `getJson` already).

`src/lib/nhl/schedule.ts`
- `getDaySchedule` keeps its 404 → "zero games" behaviour, but the underlying fetch must
  now go through the same retry helper. Export the helper from `client.ts` rather than
  duplicating it here.

`src/lib/ingest/daily.ts`
- Replace the sequential `for (const g of games)` with
  `runWithConcurrency(candidates, 6, …)`. Filter to ingestable games first, then fan out.
  6 is deliberate: `syncTeamRoster` already uses 15 internally, and the 429 above came
  from stacking those bursts — keep total in-flight requests modest against a free,
  unauthenticated public API.
- `teamsInvolved` and the counters are written from concurrent callbacks, so accumulate
  into local arrays and reduce afterwards rather than `+= 1` from inside the workers.

### Verification

- `npx tsc --noEmit` and `npm run build` clean.
- Time it for real: a throwaway script that calls `ingestDate("2025-10-11")` (the 16-game
  day) and prints elapsed seconds, `gamesIngested`, and `errors.length`. Must come back
  **16 ingested, 0 errors**, and materially faster than the 75.4s baseline recorded above.
  Delete the script before committing.
- Force a retry: temporarily point `getJson` at a URL that 429s (or run the 16-game ingest
  twice back-to-back, which is what triggered the live 429) and confirm the run **succeeds
  through the retry** instead of throwing. Note the observed behaviour in PROGRESS.md.
- Confirm idempotency held: total `GameStatLine` row count is unchanged at **52,478**
  after re-ingesting that day.

### Checklist
- [ ] `fetchWithRetry` in `client.ts`, used by `getJson` and `getDaySchedule`
- [ ] 404 still means "no games", not an error
- [ ] `ingestDate` fans out at concurrency 6, counters accumulated safely
- [ ] 16-game day: 16 ingested, 0 errors, faster than 75.4s
- [ ] Retry path observed working, not just written
- [ ] Row count still 52,478
- [ ] PROGRESS.md section + commit

---

## Task 2 — The cron route cannot be aborted by one failing phase

Fixes defect #2.

### Changes

`src/lib/players/sync.ts`
- Wrap the `getTeamRoster(teamAbbrev)` call in `syncTeamRoster` in a try/catch. On failure
  return `{ team, playersSynced: 0, failures: [{ playerId: -1, error }] }` rather than
  throwing — a `playerId` of `-1` marks "the roster fetch itself failed", distinct from a
  per-player failure. Document that sentinel in a comment.
- `syncRosters` keeps iterating teams after one fails.

`src/app/api/cron/daily-ingest/route.ts`
- Introduce a local `async function phase<T>(name, fn)` that runs `fn`, and on throw
  records `{ phase: name, error }` into a `phaseErrors` array and returns `null`. Wrap
  **every** phase in it: ingest, roster sync, injury sync, waivers, FAAB, trades, lineup
  materialization, playoffs.
- The lineup-materialization loop gets its own inner try/catch **per team/date** — one
  team's bad data must not cost every other team its lineup.
- Always return **200** with `{ ok: phaseErrors.length === 0, phaseErrors, …existing
  fields }`. Never a 500. A 500 tells Vercel to retry the whole thing, which is worse than
  a partial success plus a recorded error.
- Keep `maxDuration = 60`.

### Verification

- `npx tsc --noEmit`, `npm run build`.
- Simulate the real failure: temporarily make `getTeamRoster` throw unconditionally, call
  the route locally with the right bearer token, and confirm the response is **200**, that
  `phaseErrors` names `rosterSync`, and — the actual point — that `waivers`, `faab`,
  `trades`, and `lineups` all still report having run. Revert the sabotage.
- Confirm a clean run still reports `ok: true` with an empty `phaseErrors`.
- `grep -rn "TEMP:" src/` clean before commit.

### Checklist
- [ ] `getTeamRoster` failure caught, `-1` sentinel documented
- [ ] Every phase wrapped; per-team/date try/catch inside the lineup loop
- [ ] Route returns 200 even with a failed phase; never 500
- [ ] Sabotage test proves downstream phases still run
- [ ] Clean run still `ok: true`
- [ ] PROGRESS.md section + commit

---

## Task 3 — Heal-forward window + a visible `IngestRun` record

Fixes defects #1, #4. **This is the most important task in the batch.**

### Changes

`prisma/schema.prisma` — new model:

```prisma
model IngestRun {
  id               String   @id @default(cuid())
  startedAt        DateTime @default(now())
  finishedAt       DateTime?
  datesAttempted   String[]          // the heal-forward window actually walked
  gamesFound       Int      @default(0)
  gamesIngested    Int      @default(0)
  gamesSkipped     Int      @default(0)
  statLinesWritten Int      @default(0)
  phaseErrorsJson  Json?             // [{ phase, error }] from Task 2, null when clean
  ingestErrorsJson Json?             // per-game errors, null when clean
  ok               Boolean  @default(false)

  @@index([startedAt])
}
```

Migration name: `add_ingest_run`.

`src/lib/ingest/daily.ts`
- New `INGEST_HEAL_DAYS = 3`.
- New `ingestRecentDates(days = INGEST_HEAL_DAYS)`: walks `yesterdayUTC()` back `days - 1`
  further (so 3 = yesterday, -2, -3), calls `ingestDate` for each, and returns a merged
  result plus the per-date breakdown. Keep `ingestDate` exactly as it is — one date, one
  job — so `scripts/` callers and the verification scripts are unaffected.
- Document *why* 3 days, referencing the FINAL-vs-OFF case and the missed-run case, in the
  same voice as `yesterdayUTC`'s existing comment.

`src/app/api/cron/daily-ingest/route.ts`
- Create the `IngestRun` row at the top (so a run killed by the platform timeout still
  leaves a `finishedAt: null` row — that absence *is* the signal).
- Call `ingestRecentDates()` instead of `ingestDate(yesterdayUTC())`.
- Update the row at the end with totals, `phaseErrorsJson`, `ingestErrorsJson`,
  `finishedAt`, and `ok`.
- Keep the existing JSON response shape and add `ingestRunId`.

`src/lib/ingest/games.ts`
- `ingestGame` already returns `playerLinesWritten`; make sure `ingestDate` sums it so
  `statLinesWritten` is real and not a guess.

### Verification

- `npx prisma migrate dev --name add_ingest_run`, then `npx tsc --noEmit`, `npm run build`.
- Call the route locally with the correct bearer token during the **offseason**: expect
  `datesAttempted` = 3 dates, `gamesFound` reflecting preseason games, `gamesIngested: 0`
  (preseason is `gameType` 1 and correctly skipped), `ok: true`, and a completed
  `IngestRun` row with `finishedAt` set.
- Prove heal-forward actually heals. On a disposable copy of the situation: delete the
  `GameStatLine` rows for **one** game from **one** date inside the window (record the
  exact `gameId` first), re-run, and confirm the rows come back and the count returns to
  **52,478**. Use an exact `gameId` — never a blanket delete — per the shared-prod-database
  convention.
- Confirm a wrong bearer token still returns 401 and writes **no** `IngestRun` row.

### Checklist
- [ ] `IngestRun` model + `add_ingest_run` migration
- [ ] `ingestRecentDates` with a documented 3-day window; `ingestDate` unchanged
- [ ] Row created before work, updated after; timeout leaves `finishedAt: null`
- [ ] `statLinesWritten` summed from real return values
- [ ] Offseason run: 3 dates attempted, preseason skipped, `ok: true`
- [ ] Deleted-game heal test passes, back to 52,478
- [ ] 401 path writes no row
- [ ] PROGRESS.md section + commit

---

## Task 4 — Opening-night dress rehearsal (no feature work)

The whole point of Tasks 1–3. **Run this before 2026-09-29.**

### Changes

`scripts/ingest-dress-rehearsal.ts` (new, follows `roster-action-check.ts`'s
runnable-regression-check convention)
- Takes a date argument, defaults to the busiest known slate `2025-10-11` (16 games).
- Runs the **full cron body** — not just `ingestDate`: heal-forward ingest, roster sync for
  the teams involved, injury sync, waivers, FAAB, trades, lineup materialization, playoffs
  — timing each phase and printing a table.
- Prints a loud **PASS/FAIL against the 60s budget**, with the per-phase breakdown so a
  failure names the phase.
- Read-only with respect to leagues: it must not create or delete any league, team, or
  roster row. Stat-line upserts are idempotent and expected.

### Verification

- Run it for `2025-10-11` (16 games) and for a preseason-only date (the quiet-day case).
  Record both wall-clock totals and the per-phase breakdown verbatim in PROGRESS.md.
- If the 16-game total exceeds ~45s (leaving headroom under 60), **stop and report** rather
  than pushing on: the next move is moving roster sync to its own weekly cron or a queue,
  which is a scope decision for the user, not something to improvise here.
- Confirm `GameStatLine` is still **52,478** rows and no league/team/roster row changed
  (count them before and after).

### Checklist
- [ ] `scripts/ingest-dress-rehearsal.ts` runs the full cron body with per-phase timing
- [ ] 16-game day measured; PASS/FAIL vs the 60s budget stated plainly
- [ ] Quiet preseason day measured
- [ ] Both timings recorded in PROGRESS.md
- [ ] Row counts unchanged; no league/team/roster mutations
- [ ] Escalate instead of improvising if over budget
- [ ] PROGRESS.md section + commit

---

## Task 5 — NHL playoff games ingest

Fixes defect #5. Not urgent for September, essential before April.

### Changes

`src/lib/ingest/daily.ts`
- `g.gameType !== 2` → `g.gameType !== 2 && g.gameType !== 3`. Replace the existing
  "playoffs are Stage 6+ territory" comment with the real reason they're now in: a
  league's fantasy playoff bracket runs against real NHL playoff games, and skipping them
  scores every playoff matchup at zero.
- Preseason (`gameType` 1) and All-Star (4) stay skipped.

`scripts/backfill-season.ts`
- Same widening, so a manual repair covers playoff games too.

### Verification

- Ingest a real 2026 NHL playoff date (the 2025-26 postseason is in the NHL's API but not
  in our DB — that's the point). Pick a date, confirm games ingest, spot-check one
  player's line against `api-web.nhle.com/v1/gamecenter/{id}/boxscore`.
- Confirm the row count **increased** by the expected amount and that `STAT_RANGES`'s
  `2025` bucket (ends 2026-07-31) now includes those playoff games — this changes existing
  season totals, so note it in PROGRESS.md explicitly as an intended data change.
- Confirm preseason is still skipped: run for a September preseason date and expect
  `gamesIngested: 0`.

### Checklist
- [ ] `gameType` 3 ingests; 1 and 4 still skipped
- [ ] `backfill-season.ts` widened to match
- [ ] Real playoff date ingested and spot-checked against the boxscore
- [ ] Season-total impact noted as intended in PROGRESS.md
- [ ] PROGRESS.md section + commit

---

## Task 6 — Close the scoring-path divergence, add `powerPlayGoals`, drop the dead leagues

Fixes defects #6, #7, and the test-league cleanup.

### Changes

`src/lib/players/rankings.ts`
- Add `takeaways` and `giveaways` to `PlayerAggregateRow` and to the
  `getPlayerStatsAggregate` SQL, in the same `COALESCE(SUM(...))::float` form as the
  neighbours.
- Add `powerPlayGoals` the same way.

`src/lib/scoring/engine.ts`
- Add `takeaways`, `giveaways`, `powerPlayGoals` to `StatTotals` and to
  `computeFantasyPointsFromTotals` — **the two scoring paths must agree field for field.**
- Add `powerPlayGoals?: number` to `ScoringConfig`, to `RawStatLine`, to the skater branch
  of `computeFantasyPoints`, and to `EDITABLE_SCORING_FIELDS` as
  `{ key: "powerPlayGoals", label: "Power Play Goals" }`.
- Add a comment above `computeFantasyPointsFromTotals` stating the invariant: every field
  `computeFantasyPoints` reads must also be summed here, or the per-game and aggregate
  paths silently disagree. Name this batch as the reason.

`src/lib/players/columns.ts`
- Add `{ key: "powerPlayGoals", label: "PPG" }` to `SKATER_COLUMNS`. Leave TK/GV out of
  the default columns — they're scorable but not worth the horizontal space; the profile
  modal is the place for them if the user wants them later.

Cleanup (separate, in the same commit — it's the same "stop wasting cron budget" concern):
- Extend `scripts/cleanup-test-leagues.ts` if needed and run it against the **8** leftover
  test leagues, by exact name, keeping **"Experimenting"** untouched. List the 8 names in
  the commit message.

### Verification

- `npx tsc --noEmit`, `npm run build`.
- **Prove the divergence is closed.** A throwaway script that, for one real player and a
  config with `takeaways: 1, giveaways: -0.5, powerPlayGoals: 1`, computes the total both
  ways — summing `computeFantasyPoints` over that player's raw lines, and one
  `getPlayerStatsAggregate` row through `computeFantasyPointsFromTotals` — and asserts the
  two are equal to within floating-point tolerance. Run it for a skater *and* a goalie.
  This assertion is the whole task; do not skip it. Delete the script after.
- Spot-check `powerPlayGoals` for one player against the NHL realtime endpoint the way the
  hits table above did.
- Real browser: Players page shows the PPG column and sorts by it; Adjust Scoring shows
  Power Play Goals and saves a value; the player modal still renders.
- After cleanup: `League` count is **1**, and "Experimenting" plus all its teams, rosters,
  lineups, and matchups are intact (count them before and after).

### Checklist
- [ ] TK/GV/PPG summed in the aggregate SQL and in `StatTotals`
- [ ] `powerPlayGoals` scorable and editable; PPG column added
- [ ] Invariant comment on `computeFantasyPointsFromTotals`
- [ ] Equality assertion passes for a skater and a goalie
- [ ] PPG spot-checked against NHL's own numbers
- [ ] 8 test leagues gone, "Experimenting" fully intact
- [ ] PROGRESS.md section + commit

---

## Task 7 — Default scoring: stop shipping hits and blocks at zero

The user's original concern, reduced to what's actually actionable in code.

### Changes

`src/lib/scoring/engine.ts`
- In `STARTER_SCORING`, set `hits: 0.5` and `blockedShots: 0.5` (ESPN's own standard
  optional-category values), leaving `pim`, `plusMinus`, `takeaways`, `giveaways` at 0.
- Update the comment block: mark which values are confirmed ESPN defaults vs. chosen here,
  and state that this affects **new leagues only** — existing leagues keep their stored
  `settingsJson.scoringConfig` and change it through Adjust Scoring.

`src/app/leagues/[id]/settings` (Adjust Scoring)
- Add one line of helper text near the hits/blocks fields: these are tracked for every
  game and are worth points as soon as a value is set. No layout redesign.

**Not done in code:** changing the live "Experimenting" league's config. That's a
commissioner action through the UI, and it retroactively changes every already-played
matchup score (points are computed on read — DESIGN.md §4.1). Flag that consequence to the
user and let them decide the timing; if they want it done, it's one Adjust Scoring save,
not a migration.

### Verification

- Create a disposable test league, confirm its stored config carries `hits: 0.5` and
  `blockedShots: 0.5`, and confirm a known hitter's fantasy total on the Players page moves
  by exactly `0.5 × hits + 0.5 × blocks` versus the same player in "Experimenting". Delete
  the test league by exact name.
- Confirm "Experimenting" is **unchanged** — same config, same totals as before the commit.
- Real browser check of the Adjust Scoring helper text.

### Checklist
- [ ] `STARTER_SCORING` hits/blocks at 0.5; comment explains new-leagues-only
- [ ] Adjust Scoring helper text added
- [ ] New-league config verified; arithmetic checked against a known hitter
- [ ] "Experimenting" provably untouched
- [ ] Retroactive-rescore consequence flagged to the user, not silently applied
- [ ] PROGRESS.md section + commit

---

## Explicitly out of scope

- **Live / in-game stat tracking.** Needs (a) Vercel Pro — Hobby allows one cron trigger
  per project per day, a hard platform cap; (b) a provisional store separate from
  `GameStatLine`, which is final-only on purpose because NHL scorers reassign assists days
  later (DESIGN.md §4.1); (c) a UI that distinguishes provisional from final. Its own plan.
- **True PPP / SHP.** The boxscore has no power-play assists and no shorthanded goals.
  Needs a play-by-play feed. `powerPlayPoints`/`shorthandedPoints` stay no-op fields.
- **Faceoff wins/losses as counts.** Only `faceoffWinningPctg` is published per game.
- **Goalie losses / OT losses as scoring categories.** `decision` is stored (`"W" | "L" |
  "O"`) so the data is there — but adding them means new `StatTotals` fields and another
  pass over both scoring paths. Worth doing; deliberately not bundled into Task 6, which
  already carries the invariant fix.
- **Dynasty season rollover.** In `BACKLOG.md`, user said "not yet". Note that a DYNASTY
  league still cannot advance `currentSeason`, so 2026-27 data will ingest correctly but
  the league's own season framing does not advance.
- **`STAT_RANGES` needs a `2027` entry before 2027-08-01** or `currentAndLastSeason`
  silently falls back to the latest entry. Already recorded in PROGRESS.md's known gaps;
  not this batch.
