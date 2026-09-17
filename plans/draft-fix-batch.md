# Plan — Draft fix batch (Sept 2026)

The first real startup draft on "Experimenting" (2026-09-16) went wrong in four distinct
ways. This plan fixes the code and cleans up the league. Four tasks, in order, one commit
each. **All decisions below are confirmed with the user — don't re-ask.** Same working
rules as the previous plans (`PROGRESS.md` first; real browser verification; exact-name
test-data cleanup on the shared prod database; `// TEMP:` auth bypasses reverted before
commit; commit messages explain *why*).

**Kickoff prompt for an implementing session:**
> Read `PROGRESS.md`, then `plans/draft-fix-batch.md`. Implement **Task N** only, exactly as
> specified — the design decisions are already made. Verify per the task's Verification
> section, update PROGRESS.md, tick the checklist, commit (don't push).

## What happened (from the database, read-only)

Draft `cmu4ml8b60003l304ps7kjoa6`, STARTUP, season 2027, 20 rounds × 3 teams = 60 picks,
90s timer, status COMPLETE. Results:

1. **Every pick was recorded ~4 times.** 60 picks → **228 open `RosterSlot` rows**, 228
   `DRAFT_PICK` transaction-log rows, rosters of 75/77/76 against a 19+6 cap, **70 players
   rostered twice** (same team, e.g. "Joey Daccord: Dev, Dev"). Timeline: pick #1 manual
   at 21:41, #2 autopick at 21:43, then nothing until **01:37 the next day**, when picks
   #3–#60 all resolved within ~30 seconds. The clock only advances on read
   (`resolveDraftState`, see file header of `src/lib/draft/mutations.ts`), and the room
   polls every 3s (`POLL_MS`). When the room was reopened, every poll (and the page load)
   started its own catch-up loop through 58 expired picks; the loops raced. Nothing in
   `getCurrentPick → recordPick → advanceDeadline` is atomic: two callers see the same
   unused pick, both `rosterSlot.create`, both `draftPick.update`, both log.
2. **Autopick drafted 24 goalies in a row.** Pick positions in order:
   `G×24 L R L L R C G G L D R L R C G R C C R G C L L C C C C R D R L C C D`. 69 of the
   139 distinct players drafted are goalies; 6 are defencemen. `getDraftPool` for a
   STARTUP draft is the whole pool sorted by **career fantasy points** with no positional
   awareness, and goalies score far more than skaters under the scoring config.
3. **No roster-cap awareness.** `recordPick` always creates `slotType: "ACTIVE"`.
   `setUpDraft`/`updateDraftSetup` only require `roundCount >= 1`; the form defaults to 20
   rounds for a 19-active roster.
4. **Nothing happens while nobody is watching.** By design (Vercel Hobby cron is once a
   day) the clock is read-driven. The user expected "let it autodraft by itself"; instead
   it froze for 3.5 hours and then hit bug 1.

Also observed, not a bug but a cost: `buildView` calls `getDraftPool` on **every** poll for
**every** open client — that's the full ~1.5s `getPlayerStatsAggregate()` over ~1,100
players every 3 seconds per tab.

## Decisions already made (don't re-open)
- **Idle drafts:** the room states plainly that the clock runs while the page is open, and
  the commissioner gets an **"Autodraft remaining picks"** button that finishes the draft
  immediately with the needs-based autopick. No background job.
- **Rookie draft picks land on Farm first**, Active only if the farm is full. **Startup
  picks land on Active first**, Farm when Active is full.
- **Experimenting cleanup: delete the botched draft entirely** (its picks too) along with
  every roster slot, pick log, and lineup row it produced. The user sets up a fresh draft
  from Settings after the fix ships. Free agency correctly re-locks (no COMPLETE startup
  draft) as a consequence.
- Autopick ranking uses **the most recent fully-ingested season's fantasy points** (today:
  2025-26), tie-break career points — not career alone, which over-rewards long tenures.
- The broader "draft needs a significant overhaul" backlog item (room UX, setup flow) is
  **not** this batch. Only what's needed to make a draft produce a correct result.

---

## Task 1 — Make pick recording atomic, cap-aware, and cheap

### Changes (`src/lib/draft/mutations.ts` unless noted)
1. **Resolver lease.** Add `Draft.resolvingUntil DateTime?` (Prisma migration,
   `prisma migrate dev --name add_draft_resolving_lease`). At the top of the
   `resolveDraftState` loop body — before `getCurrentPick` — acquire the lease:
   ```ts
   const claimed = await prisma.draft.updateMany({
     where: { id: draftId, status: "IN_PROGRESS", OR: [{ resolvingUntil: null }, { resolvingUntil: { lt: now } }] },
     data: { resolvingUntil: new Date(now.getTime() + LEASE_MS) },   // LEASE_MS = 15_000
   });
   if (claimed.count === 0) return buildView(draft);  // someone else is resolving — read-only view
   ```
   Release it (`resolvingUntil: null`) in a `finally` when the call ends. Any caller that
   can't get the lease just returns the current view; the polling client will see the
   other resolver's progress on its next tick.
2. **Bounded catch-up.** Replace the `for (let i = 0; i < 1000; i++)` with
   `MAX_AUTOPICKS_PER_CALL = 8`. After 8 autopicks the call returns; the client keeps
   polling and the next call continues. This keeps every request well inside serverless
   time limits (each autopick costs a pool computation).
3. **Atomic pick claim.** Rewrite `recordPick` as an interactive `$transaction(async (tx) => …)`:
   - `tx.draftPick.updateMany({ where: { id: pick.id, usedOnPlayerId: null }, data: { usedOnPlayerId: playerId } })`
     → if `count !== 1`, throw `PickAlreadyTakenError` (someone else recorded it; the
     caller catches it and simply re-reads).
   - Defensive double-roster guard: `tx.rosterSlot.count({ where: { playerId, effectiveTo: null, team: { leagueId } } })`
     must be 0, else throw (and let the claim roll back).
   - Determine `slotType` (step 4) from counts read inside the same transaction, then
     `tx.rosterSlot.create` and `tx.transactionLog.create` as today. Also
     `ensureLineupMaterialized` is **not** called here (unchanged decision from the
     team-page batch — the first team-page view auto-fills).
4. **Cap-aware `slotType`.** `slotTypeForDraftPick({ activeCount, farmCount, settings, draftType })`:
   - STARTUP: `ACTIVE` if `activeCount < activeRosterCap(settings)`, else `FARM` if
     `farmCount < settings.farmSlots`, else throw `"Roster is full — the draft has more rounds than roster spots."`
   - ROOKIE: `FARM` if `farmCount < settings.farmSlots`, else `ACTIVE` if room, else throw.
5. **Round-count validation** in `setUpDraft` and `updateDraftSetup`:
   `maxRounds = activeRosterCap(settings) + settings.farmSlots − max(open roster count across teams)`;
   throw `"This league's rosters have room for at most N more players per team — reduce the round count."`
   when `roundCount > maxRounds`. Expose `getMaxDraftRounds(leagueId)` for the form.
6. **Pool cost.** Split `getDraftPool` into (a) a memoized ranked base list per
   `(leagueId, season, type)` with a 60s TTL (module-level `Map`; per serverless instance
   is fine — a stale minute only affects ordering, never correctness, because ownership
   filtering stays live), and (b) the live ownership filter. Task 2 replaces the ranking
   inside (a); keep the interface `getDraftPool(draft, teamId?)` so Task 2 can add the
   needs-aware ordering per team. `buildView` keeps returning the pool for the room's list.
7. `makeDraftPick`: catch `PickAlreadyTakenError` from `recordPick` and rethrow as
   `"That pick was just made — the board has moved on."`

### `src/app/leagues/[id]/settings/DraftSetupForm.tsx` / `DraftSetupEditForm.tsx`
- `roundCount` input gets `max={maxRounds}`, `defaultValue={Math.min(20, maxRounds)}` for
  STARTUP (`Math.min(1, maxRounds)` for ROOKIE… i.e. 1), and helper text
  "Max N rounds — active roster + farm, minus players already rostered."

### Verification — `scripts/draft-concurrency-check.ts`
Disposable league (exact name, `deleteLeague` cleanup), 3 teams, small caps (e.g. active 3,
farm 2), 5-round STARTUP draft, 10s timer. Start it, then set `currentPickDeadline` to an
hour ago directly, then fire **6 concurrent** `resolveDraftState(draftId)` calls via
`Promise.allSettled`, repeat until COMPLETE. Assert: exactly 15 open roster slots
(5 × 3), exactly 15 `DRAFT_PICK` logs, zero players with more than one open slot, every
pick's `usedOnPlayerId` set exactly once, per-team counts = 3 ACTIVE + 2 FARM, and that at
most `MAX_AUTOPICKS_PER_CALL` picks were recorded by any single call (count logs between
calls). Also: `setUpDraft` with `roundCount = 6` throws the max-rounds message; a ROOKIE
draft's picks land on FARM. Then `npx tsc --noEmit`, `npm run build`. Browser: settings
form shows the max and helper text (`// TEMP:` bypass, reverted). No other UI change.

---

## Task 2 — Needs-based autopick ranking

### Ranking (`src/lib/draft/ranking.ts`, new, pure functions + one data loader)
- **Position groups** follow the league's `positionMode`: COMBINED → `F` (C/L/R), `D`,
  `G`; SEPARATE → `C`, `L`, `R`, `D`, `G`. Reuse `eligibleSlotsForPosition` /
  `capFor` from `src/lib/lineups/mutations.ts` rather than re-deriving.
- **Per-team target** per group: starters for that group (`capFor`) + a bench share.
  Bench share: `UTIL + BENCH` slots split across **skater** groups proportionally to their
  starter counts (round half up; any remainder goes to the largest group). Goalies get a
  bench share of exactly **1**. Hard cap: a team never autopicks more than `capFor("G") + 1`
  goalies, ever (including farm rounds).
- **Player value** = fantasy points in the most recent fully-ingested season
  (find the max `GameStatLine.gameDate`, pick the `STAT_RANGES` season containing it,
  `getPlayerStatsAggregate({ scoringConfig, dateRange })`), tie-break career points, then
  name. Players with zero games in that season rank by career, below everyone with games.
- **Value over replacement (VOR)** for a group = `value(best available in group) −
  value(replacement)`, where replacement = the player at index
  `remainingLeagueNeed[group]` in that group's sorted available list (clamped to the last
  player), and `remainingLeagueNeed[group] = Σ over teams of max(0, target − have)`.
- **Autopick for a team:**
  1. Compute `need[group] = max(0, target[group] − have[group])` from the team's current
     open roster slots (all tiers).
  2. Among groups with `need > 0` and available players, choose the group with the
     highest VOR; take its best available player.
  3. If no group has need (farm rounds), take the best available player by raw value,
     skipping any group at its hard cap.
  4. If the pool is empty, throw as today.
- **Board order for the room** (`getDraftPool` ordering): the same value ranking (not
  per-team needs), so managers picking manually see a sensible list. Add a position
  filter row to the room (`All · F/C/L/R per mode · D · G`) — small, same tab-button style
  as the Players page.
- ROOKIE drafts keep the NHL-draft-position ranking (prospects have no stats), but **do**
  apply the goalie hard cap and needs step so a team doesn't autopick three goalie
  prospects.
- Autopick log payload gains `group` and `reason: "NEED" | "BEST_AVAILABLE"`.

### Verification — `scripts/draft-ranking-check.ts`
Pure-function tests first (no DB): given a fabricated pool and a COMBINED roster
`F:6 D:4 G:2 UTIL:1 BENCH:6`, assert targets are `F: 6+4=10ish, D: 4+3ish, G: 3` per the
bench-share rule (write the expected numbers in the script from the rule, not from the
code), that a team with two goalies never gets a third before its skater needs are met,
and that the pick sequence for one team over 19 picks contains ≤ 3 goalies and ≥ 4 D.
Then a DB run: disposable league, 3 teams, Experimenting's exact composition, 19-round
STARTUP draft, fully autodrafted via repeated `resolveDraftState` with a backdated
deadline; assert every team has ≤ 3 G, ≥ 4 D, ≥ 6 F, and no player rostered twice. Browser:
room's board shows skaters and goalies interleaved sensibly at the top (screenshot the
first 15) and the position filter works. `npx tsc --noEmit`, `npm run build`.

---

## Task 3 — Room notice + commissioner "Autodraft remaining picks"

- `DraftRoom.tsx`: under the clock, a muted line: "The clock only runs while someone has
  this page open. Picks left unmade when the timer hits zero are auto-drafted."
- Commissioner-only button **"Autodraft remaining picks"** (confirm step: "Auto-draft all
  N remaining picks now? This can't be undone."). Implementation: server action
  `autodraftBatchAction(leagueId, draftId)` → new `autodraftBatch(draftId, callerUserId)`
  in `draft/mutations.ts`: commissioner check, acquire the same lease as Task 1, make up to
  `MAX_AUTOPICKS_PER_CALL` picks **ignoring the deadline** (forced autopick, logged with
  `autopicked: true, forced: true`), release the lease, return the view. The **client loops**
  the action while `status === "IN_PROGRESS"`, showing "Auto-drafting… pick N of M", so a
  60-pick draft completes in a handful of short requests instead of one long one that
  could hit a serverless timeout.
- When status flips to COMPLETE, the room shows "Draft complete" with a link to the
  viewer's team page (where the first view auto-fills their lineup — say so in the text).
- `PROGRESS.md`: document the read-driven clock honestly in the Draft section.

### Verification
Disposable league; browser as the commissioner (`// TEMP:`): start a 10-round draft, make
one manual pick, click Autodraft remaining → progress text advances → COMPLETE → link to
team page → team page shows the drafted roster auto-filled into slots. As a non-commissioner
manager the button is absent. Script: `autodraftBatch` from a non-commissioner throws;
running it concurrently with `resolveDraftState` produces no duplicates (reuse Task 1's
assertions). `npx tsc --noEmit`, `npm run build`, cleanup, `grep -rn "TEMP:" src/` clean.

---

## Task 4 — Clean up Experimenting (one-off, run after Tasks 1–3 are committed)

`scripts/reset-experimenting-botched-draft.ts`, with `--dry-run` (prints everything it
would touch, writes nothing). Run the dry run first and include its output in the report.
1. Match league by **exact name "Experimenting" AND id `cmts0s1uu0000lc0405mux8c5`**;
   abort otherwise.
2. Find the STARTUP 2027 draft (`cmu4ml8b60003l304ps7kjoa6`). Abort if not found or if
   any `TradeItem` references any of its picks (expect 0).
3. Assert **every** open `RosterSlot` for the league's teams has `effectiveFrom >= draft.createdAt`
   (i.e. all came from this draft — the league had 0 open slots beforehand, per the
   2026-09-15 reset). Abort if any predates it. Expect 228.
4. Delete, in one transaction: `LineupEntry` for the league's teams (expect 14);
   those `RosterSlot` rows (228 — **delete**, not close: they're bug artifacts, not
   history); `TransactionLog` rows with `type: "DRAFT_PICK"` for the league created
   `>= draft.createdAt` (expect 228); the draft's `DraftPick` rows (60); the `Draft` row.
   Write one `TransactionLog` `{ type: "COMMISSIONER_RESET", payload: { reason: "botched startup draft removed", draftId } }`.
5. Print before/after counts. Then a read-only snapshot: open slots 0, lineup rows 0,
   drafts 0, `getFreeAgencyStatus` → closed / `NO_STARTUP_DRAFT`, Players page (browser,
   read-only) shows the "set up the draft" banner again.
Keep the script in the repo; note the run date in PROGRESS.md.

## Checklist
- [x] Task 1 — atomic, cap-aware, bounded pick recording (+ lease migration)
- [ ] Task 2 — needs-based autopick ranking + room board order/filter
- [ ] Task 3 — room notice + Autodraft remaining picks
- [ ] Task 4 — Experimenting cleanup (run once; record date)
