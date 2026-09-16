# Plan — Team page batch (Sept 2026)

Five user-reported issues, planned in one pass so the implementing sessions don't have to
re-derive root causes or re-ask design questions. **Every design decision below has already
been confirmed with the user — do not re-ask them.** If you hit something this plan
genuinely doesn't cover, say so in your final report rather than guessing.

## How to use this plan

- Read `PROGRESS.md` first (repo root), then this file, then the task you've been assigned.
- One task per session, one commit per task, in the order listed in "Execution order".
  Tasks touch overlapping files (`teams/[teamId]/page.tsx` especially) — running them in
  parallel will produce merge conflicts.
- Working conventions from PROGRESS.md apply in full. The ones that bite here:
  - `npx tsc --noEmit` → `npm run build` → **real browser check** via `preview_start`
    against real seeded data, before claiming anything works. Auth-gated pages get a
    temporary hardcoded userId marked `// TEMP:`, reverted before commit
    (`grep -rn "TEMP:" src/` must be clean).
  - Local dev and production share **one Neon database**. Every script names its test
    data distinctly (e.g. `"... Test League (delete me)"`) and cleans up by exact name.
    Never a blanket `deleteMany`.
  - `AGENTS.md` says this Next.js version differs from training data — read
    `node_modules/next/dist/docs/` when touching routing/params/server actions.
  - Commit messages explain *why*, written for a future session to read.
- When a task ships: move its entry into `PROGRESS.md` (new section at the bottom, same
  style as the existing ones), and tick it off in the checklist at the end of this file.

## Execution order

| # | Task | Issue(s) | Size | Depends on |
|---|------|----------|------|------------|
| 1 | Stat range dropdown: Last 7 / Last 30 days, also on Players page | #2 | S | — |
| 2 | Team header restructure + Notifications modal | #1, #3 | M | — (touches `page.tsx` header; task 1 touches its view logic — sequential to avoid conflicts) |
| 3 | Free agency locked until the draft + one-off roster reset | #5 | M | — |
| 4 | Persistent lineups + auto-fill open slots | #4 | L | Do last. Biggest blast radius; the others shouldn't wait on it. |

---

## Task 1 — Stat range dropdown (issue #2)

### Goal (product)
The team page's stats dropdown (`Daily / 2025-26 / 2026-27`) gains **Last 7 Days** and
**Last 30 Days**. The Players page gets the same dropdown (season + rolling options; no
"Daily" there — Daily is tied to the team page's date strip and means nothing on Players).

### Current state
- `src/lib/players/seasons.ts` — `SEASONS[]` (two season windows) + `seasonByValue()`.
- Team page `src/app/leagues/[id]/teams/[teamId]/page.tsx` ~L283-290: `view === "daily"`
  → `getPlayerDailyStats`, else `getPlayerStatsAggregate({ dateRange: seasonByValue(view) ?? seasonByValue("2025") })`.
- `ViewControls.tsx` renders the `<select>` from `SEASONS`.
- Players page `src/app/leagues/[id]/players/page.tsx` has **no dropdown at all** — both
  `getPlayerStatsAggregate` calls pass no `dateRange` (= career totals, which happen to
  equal 2025-26 because only one season is ingested). Header text is hardcoded
  "2025-26 season stats".
- `getPlayerStatsAggregate` already supports `dateRange: { start, end }` on the JOIN — no
  query changes needed.

### Changes
1. **`src/lib/players/seasons.ts`** — generalize to stat ranges:
   ```ts
   export type StatRangeOption =
     | { value: string; label: string; kind: "season"; start: Date; end: Date }
     | { value: string; label: string; kind: "rolling"; days: number };
   export const STAT_RANGES: StatRangeOption[] = [
     { value: "last7",  label: "Last 7 Days",  kind: "rolling", days: 7 },
     { value: "last30", label: "Last 30 Days", kind: "rolling", days: 30 },
     { value: "2025",   label: "2025-26", kind: "season", start: ..., end: ... },  // existing
     { value: "2026",   label: "2026-27", kind: "season", start: ..., end: ... },  // existing
   ];
   /** `today` is injectable so scripts can anchor a rolling window on a date that has data. */
   export function resolveStatRange(value: string, today: string = todayUTC()): { start: Date; end: Date; label: string } | undefined
   ```
   Rolling window = `days` calendar days **including today**: start = `shiftDate(today, -(days-1))` at `00:00:00.000Z`, end = `today` at `23:59:59.999Z`. Import `todayUTC`/`shiftDate` from `@/lib/dates` (client-safe). Keep the existing season `value`s (`"2025"`, `"2026"`) so bookmarked URLs keep working. Remove `SEASONS`/`seasonByValue` once all callers are migrated (grep).
2. **`ViewControls.tsx`** — options: `Daily`, then `STAT_RANGES` in order.
3. **Team page `page.tsx`** — replace `seasonByValue(view) ?? seasonByValue("2025")` with `resolveStatRange(view) ?? resolveStatRange("2025")`. The non-daily label (~L720, currently "Season aggregate — …") becomes the resolved range's `label` (e.g. "Last 7 Days" / "2025-26").
4. **Players page** — read `?range=` search param (default `"2025"`, validate against `STAT_RANGES` values), pass `dateRange` to **both** `getPlayerStatsAggregate` calls (search and default pool). Header text becomes dynamic: `{league.name}'s scoring, {label}.`
5. **Players page dropdown** — new small client component `src/app/leagues/[id]/players/StatRangeSelect.tsx`: a `<select>` labeled "Stats" that `router.push`es with the current search params merged (`useSearchParams` → set `range`, keep `q`). Render it in `PlayerStatsTable`'s filter row (after the "Filter" select; pass `statRange` through as a prop), or directly in `page.tsx` next to `PlayerSearchBox` — either is fine, pick whichever reads cleaner. Also add `<input type="hidden" name="range" value={range} />` inside `PlayerSearchBox`'s GET form (pass `range` as a prop) so submitting a name search doesn't reset the range.
6. Update the header comment in `seasons.ts` (it currently says the dropdown is team-page only).

### Decisions already made
- Order in the dropdown: rolling options first, then seasons (`Daily · Last 7 Days · Last 30 Days · 2025-26 · 2026-27` on the team page).
- Rolling ranges show **totals**; the tables already have TOT and AVG columns so per-game averages are covered.
- It is the offseason (last ingested game: 2026-04-16). Last 7/30 will show all zeros until October. That's correct, not a bug — the user knows.

### Verification
- Script `scripts/stat-range-check.ts`: call `resolveStatRange("last7", "2026-04-16")` and `resolveStatRange("last30", "2026-04-16")`, feed each to `getPlayerStatsAggregate({ playerIds: [a few known ids], scoringConfig: STARTER_SCORING, dateRange })` and assert non-zero `gamesIngested` for at least one player, and that `last7 gamesIngested <= last30 gamesIngested`. Also assert `resolveStatRange("last7", "2026-09-16")` yields all-zero rows without throwing. No test data created — read-only.
- Browser: team page `?view=last7` and `?view=last30` render (zeros, no error, correct label); Players page `?range=last30` renders and the header text updates; changing the select navigates; submitting a name search preserves `range`.

---

## Task 2 — Team header restructure + Notifications modal (issues #1, #3)

### Goal (product)
- The header card (team name / logo / manager / roster count) loses both buttons on its
  right side. **Propose Trade** moves down to sit beside the existing `+ Add` / `− Drop`
  pills. The header's `+ Add` is deleted.
- The lower `+ Add` pill stops opening an inline search box and instead **links to the
  Players tab**. The inline search box on the team page goes away.
- The always-visible Notifications list is replaced by a **"Notifications (N)" button**
  that opens a modal listing everything.

### Current state
- Header buttons: `page.tsx` ~L586-593 (`LinkButton` Propose Trade + `+ Add`, inside `isManager`).
- Notifications list: `page.tsx` ~L619-637, data from `getTeamNotifications` (`src/lib/notifications/feed.ts`), colors via `NOTIFICATION_DOT` at top of `page.tsx`.
- Action bar `+ Add` / `− Drop`: `RosterMoveBoard.tsx` ~L300-340. `+ Add` toggles `addOpen` → renders `AddPlayerBox.tsx` (typeahead + drop-to-make-room picker). Props `activeCap` and the `activeOccupants` derivation exist for that box.
- No modal/dialog component exists anywhere in `src/components`.

### Changes
1. **`src/components/Modal.tsx`** (new, client) — reusable; the backlog's player-profile
   modal will use it next. Props: `open: boolean; onClose: () => void; title: string; children`.
   Use a native `<dialog>` (ref + `useEffect` calling `showModal()`/`close()` on `open`),
   which gives Esc-to-close and focus containment for free. Close on backdrop click
   (`e.target === dialogRef.current`). Style with the existing design tokens
   (`bg-surface`, `border-border`, `text-foreground`), `backdrop:bg-black/40`, max width
   ~`max-w-lg`, header row with title + a "✕" `Button variant="ghost"`. Light-only theme
   per PROGRESS.md's redesign section — no dark-mode styling.
2. **`src/app/leagues/[id]/teams/[teamId]/NotificationsButton.tsx`** (new, client) — props
   `notifications: TeamNotification[]` (already plain serializable data). Renders
   `<Button variant="secondary" size="sm">Notifications ({n})</Button>`; on click opens
   `Modal` titled "Notifications". Modal body = the existing list markup moved verbatim
   from `page.tsx` (dot + text + "View →" `Link`), with `NOTIFICATION_DOT` moved into this
   file. Empty state inside the modal: "Nothing needs your attention right now."
3. **`page.tsx`**:
   - Header right side: replace the Propose Trade / `+ Add` block with
     `{isManager && <NotificationsButton notifications={notifications} />}`. Always
     render for managers, even at 0 — one code path, and a small pill at 0 is fine.
   - Delete the standalone Notifications section (~L619-637).
   - Drop the now-unused `activeCap` prop from the `<RosterMoveBoard>` call if step 4 removes it.
4. **`RosterMoveBoard.tsx`** action bar becomes, left to right:
   `[Propose Trade] [+ Add] [− Drop]`
   - Propose Trade: `<LinkButton href={`/leagues/${leagueId}/trades`} variant="primary" size="sm">`.
   - `+ Add`: `<LinkButton href={`/leagues/${leagueId}/players`} variant="secondary" size="sm">`.
   - `− Drop`: unchanged toggle.
   - Remove `addOpen` state, the `AddPlayerBox` render and import, the `activeCap` prop,
     and the `activeOccupants` derivation (~L61). Verified at planning time: all three are
     used only by the `AddPlayerBox` render at ~L331-338, nothing else in the file.
5. **Delete `AddPlayerBox.tsx`.** Grep to confirm nothing else imports it. (The
   Players page has its own `AddPlayerCell` inside `PlayerStatsTable.tsx` and
   `CommissionerAddPlayerBox.tsx` is separate — leave both alone.)
6. **`src/lib/notifications/feed.ts`** — `RECENT_RESULT_LIMIT` 2 → 10. Space is no longer
   the constraint and the user asked to "see everything".

### Decisions already made
- Button variants in the action bar: Propose Trade is the single `primary`; `+ Add` and
  `− Drop` are `secondary` (Drop flips to `danger` while active, as today). Two navy
  buttons side by side reads heavy.
- The action bar stays where it is (below the Auto-Set row and the "freely editable"
  hint) — the user's screenshot shows that ordering and they only asked to move Propose
  Trade down into it.
- Non-managers (commissioner viewing another team, other viewers) never saw these buttons
  and still won't.

### Verification
- Browser, as the manager of a seeded test team with ≥1 notification (a proposed trade
  from another test team is the easiest to seed — see `scripts/trades-check.ts` for the
  pattern): header shows "Notifications (1)", no list below the header, clicking opens the
  modal with the item and a working "View →" link, Esc and backdrop click close it. Action
  bar shows the three buttons; `+ Add` lands on `/leagues/[id]/players`; `− Drop` still
  enters drop mode with the two-step confirm. Also check the 0-notifications state.
- Clean up the test league by exact name.

---

## Task 3 — Free agency locked until the draft (issue #5)

### Goal (product)
Nobody can pick up a free agent before the league has drafted. Once the startup draft
completes, free agency opens. It also re-closes while any later draft (annual rookie
draft) is actually **in progress** — not while one is merely set up.

### Rule (confirmed with the user)
`getFreeAgencyStatus(leagueId)` is **closed** when any of these hold, checked in order:
1. Any `Draft` for the league is `IN_PROGRESS` → reason `DRAFT_IN_PROGRESS`.
   **Important:** the draft clock resolves on read (`resolveDraftState` in
   `src/lib/draft/mutations.ts`). A draft whose timer fully ran out stays `IN_PROGRESS` in
   the DB until someone loads the draft room. So for every `IN_PROGRESS` draft, call
   `resolveDraftState(draft.id)` first, then re-check `status`. Otherwise a finished draft
   could keep free agency locked indefinitely.
2. `settings.leagueType === "DYNASTY"` and no `STARTUP` draft with `status: COMPLETE`
   exists for the league (any season) → reason `NO_STARTUP_DRAFT`.
3. `settings.leagueType === "REDRAFT"` and no `STARTUP` draft with `status: COMPLETE`
   exists for `league.currentSeason` → reason `NO_STARTUP_DRAFT`. (`startNewSeason` wipes
   rosters and bumps `currentSeason`, so a redraft league correctly re-locks each season.)
Otherwise **open**.

### What's gated vs. not
- **Gated** (throw `Error("Free agency is closed until the draft is complete.")` or the
  in-progress variant): `addPlayerToRoster` (`src/lib/rosters/mutations.ts`),
  `submitFaBid` (`src/lib/faab/mutations.ts`), `submitWaiverClaim`
  (`src/lib/waivers/mutations.ts`).
- **Not gated:** `commissionerAddPlayer` (explicit override tool — leave it),
  draft `recordPick` (obviously), trades (draft picks are tradeable pre-draft by design —
  `draftPickTradingEnabled`), callups / IR moves / send-downs (internal roster moves,
  not acquisitions).

### Circular-import trap (read this before writing code)
The gate needs `resolveDraftState` from `src/lib/draft/mutations.ts`, and `rosters/mutations.ts`
must call the gate. But `draft/mutations.ts` currently imports `getLeagueOwnershipMap`
from `rosters/mutations.ts` → that would be a cycle. This codebase deliberately avoids
cycles (see the header comment in `src/lib/leagues/season.ts`). Fix first:
1. Move `getLeagueOwnershipMap` (a pure read, ~L569-585 of `rosters/mutations.ts`) into a
   new `src/lib/rosters/ownership.ts`. Update the two importers
   (`src/lib/draft/mutations.ts`, `src/app/leagues/[id]/players/page.tsx`).
2. Add `getFreeAgencyStatus(leagueId)` and `assertFreeAgencyOpen(leagueId)` to
   `src/lib/draft/mutations.ts` (it's draft-state-derived; it belongs there).
3. Now `rosters/mutations.ts`, `faab/mutations.ts`, `waivers/mutations.ts` can import from
   `draft/mutations.ts`. Verify `draft/mutations.ts` imports none of those three
   (today it imports `leagues/mutations`, `rosters/ownership`, `players/rankings` — fine).

### UI
- **Players page** (`players/page.tsx`): compute `status` server-side. When closed, render
  a `Card` banner above the table:
  - `DRAFT_IN_PROGRESS`: "Free agency is paused while the draft is running." + `LinkButton` → `/leagues/[id]/draft` "Go to the draft room".
  - `NO_STARTUP_DRAFT`, draft exists in `SETUP`: "Free agency opens once the draft is complete." + link to the draft room.
  - `NO_STARTUP_DRAFT`, no draft at all: commissioner sees "Set up the draft in League Settings to open free agency." + link to `/leagues/[id]/settings`; everyone else sees "Your commissioner hasn't set up the draft yet."
  Pass `freeAgencyOpen: boolean` into `PlayerStatsTable`; when false, the ownership/Add
  column renders `—` instead of the Add pill or the FAAB bid form. Watchlist stars stay —
  building a watchlist before the draft is exactly what they're for.
- **Team page** `+ Add` pill (Task 2) still links to Players; the banner explains. No change.
- **League home Waivers section**: pre-draft there are no rostered players so nothing is
  claimable — no UI change needed. Server gate covers the edge.

### One-off data reset (confirmed with the user — run exactly once, after the gate ships)
Script `scripts/reset-experimenting-for-draft.ts`. The user's real league
**"Experimenting"** (`cmts0s1uu0000lc0405mux8c5`, DYNASTY, 3 teams: Finn 17 players, Dev 14,
Rebuild Squad 19, no drafts, 22 matchup periods) gets its rosters cleared so the user can
run a proper startup draft. Live state as of planning: 3 trades `UNDER_REVIEW`, some
pending waiver claims, 39 `LineupEntry` rows league-wide.
1. Look the league up by **exact name AND id**; abort if either doesn't match.
2. Cancel every trade in `PROPOSED`/`UNDER_REVIEW` via `cancelTrade({ tradeId, callerUserId: league.commissionerUserId, allowUnderReview: true })` — same approach `startNewSeason` uses, same reason (wiping rosters under an in-flight trade corrupts it).
3. `waiverClaim.updateMany({ where: { team: { leagueId }, result: "PENDING" }, data: { result: "CLEARED" } })`; same for `faBid` with `result: "PENDING"` → `"LOST"` (probably none — FAAB is off — but check).
4. `lineupEntry.deleteMany({ where: { team: { leagueId } } })`.
5. Close (don't delete) every open roster slot: `rosterSlot.updateMany({ where: { team: { leagueId }, effectiveTo: null }, data: { effectiveTo: now } })` — history stays in the table, same as `startNewSeason`.
6. One `TransactionLog` row per team, `type: "COMMISSIONER_RESET"`, payload `{ reason: "pre-draft roster reset" }`, so the activity feed has a record.
7. Print counts before and after. Leave `MatchupPeriod`s and teams alone.
Also delete the stale test artifact **"Roster Action Test League (delete me)"**
(`cmtrz8zlv0000ru2ssnftw9vk`, 0 players) via `deleteLeague(leagueId, league.commissionerUserId ?? <earliest team's managerUserId>)`. Leave "QTest League" / "QTest 2" (0 players) alone.
Keep the script in the repo afterwards (it's name+id scoped, so re-running is a no-op /
abort); note in PROGRESS.md that it was run and when.

### Verification
- Script `scripts/free-agency-gate-check.ts` on a disposable league: assert
  `addPlayerToRoster` throws before any draft; set up + start + complete a 1-round draft
  using `setUpDraft`/`startDraft`/`makeDraftPick` (see `scripts/draft-check.ts` for the
  pattern); assert open afterwards; set up a second draft (`ROOKIE`, next season) in
  `SETUP` → still open; start it → closed; complete → open. Also cover the
  resolve-on-read case: start a draft with a 10s timer, let the deadline pass without
  reading the room, then assert `getFreeAgencyStatus` reports open (autopicks ran). Clean
  up by exact name.
- Browser: Players page on a pre-draft test league shows the banner and no Add pills;
  after completing its draft, the pills return.
- Run the Experimenting reset script **last**, then re-run a read-only snapshot
  (`prisma.rosterSlot.count({ where: { team: { leagueId }, effectiveTo: null } })` → 0;
  trades no longer `UNDER_REVIEW`; lineup rows 0) and paste the output in your report.

---

## Task 4 — Persistent lineups + auto-fill (issue #4)

### Goal (product)
ESPN behaviour: **your lineup carries forward day to day until you change it.** A newly
acquired player lands in the first open slot he's eligible for; bench only if all his
slots are full. You never open a new day to find every player on the bench.

### Root cause (why "just fix the add path" isn't enough)
- `LineupEntry` is per `(team, player, gameDate)`. A player with no row for a date is
  shown as `BE`. **Nothing ever creates rows for a new date** except the manager clicking
  Move/Auto-Set. So every date starts empty — the screenshot (Sep 16, all 19 players on
  bench, every slot "Empty") is a date nobody had set yet.
- `autoSetLineup` benches every player without an NHL game that day (`if (!game) continue`).
  In September there are no games, so Auto-Set benches the whole roster.
- No acquisition path (`addPlayerToRoster`, `callUpToActive`, `recordPick`, trade/FAAB/
  waiver awards, commissioner add) creates a lineup row.
- Latent scoring bug: `dropPlayerFromRoster` / `sendToFarm` / trades don't delete lineup
  rows. `getTeamScoreForPeriod` sums points for every non-BE row in range, so a player
  dropped at noon still scores for you that night. (`placeOnIrClearingLineup` clears one
  date only; `activeRosterPlayerIds` papers over the capacity side of this, not scoring.)

### Design (confirmed with the user)
Storage stays per-date. Two new invariants, enforced by one idempotent function:

**`ensureLineupMaterialized(teamId: string, date: string): Promise<void>`** in
`src/lib/lineups/mutations.ts` (or a sibling `materialize.ts` — `rosters/mutations.ts`
already imports from `lineups/mutations.ts`, and lineups imports nothing from rosters/
trades/draft, so no cycle either way):
1. Load team + league settings; load the ACTIVE roster
   (`rosterSlot where teamId, slotType ACTIVE, effectiveTo null, include player`, ordered
   `effectiveFrom asc, id asc` for determinism).
2. Load explicit rows for `date`.
3. **Carry-forward.** If there are none: find the most recent `gameDate < date` that has
   rows for this team (`findFirst orderBy gameDate desc`), take those rows, keep only
   players still on the ACTIVE roster, and write them for `date`
   (`createMany({ skipDuplicates: true })` — the unique key
   `(teamId, playerId, gameDate)` makes concurrent calls safe). These become the base rows.
   If there is no prior date either, base = empty.
4. **Auto-fill.** For every active player with **no row** in base (never placed — an
   explicit `"BE"` row means "benched on purpose" and is left alone):
   - Skip him if his own game on `date` has already started (`getTeamGamesForDate(date)`
     + `isLocked`). Fetch the schedule once; skip the fetch entirely when `date < today`
     (everything is locked → auto-fill is a no-op; carry-forward alone is correct
     because the lineup "was" that all along).
   - Rank remaining candidates by career fantasy points (`getPlayerStatsAggregate({ playerIds, scoringConfig })`, exactly as `autoSetLineup` does).
   - Assign into open capacity: position slots first (`C/L/R/D/G` in SEPARATE, `F/D/G`
     in COMBINED), then `UTIL`. Open capacity per slot = `capFor(slot, comp)` minus base
     rows in that slot for active players. **Extract `autoSetLineup`'s existing
     assignment loop into a pure helper** (`assignStarters(candidates, remainingCap, positionMode)`)
     and call it from both places — don't duplicate it.
   - Write one row per assigned player. Players with no open eligible slot get **no
     row** (implicit BE) so they're re-evaluated the next time a slot opens.
5. Do the NHL schedule fetch and the stats query **before** the DB writes; wrap the writes
   in one `$transaction`.

**`clearLineupFrom(teamId: string, playerId: string, fromDate: string = todayUTC()): Promise<void>`**
— `deleteMany where teamId, playerId, gameDate >= parseGameDate(fromDate)`.

### Call sites
Materialize:
- **Team page `page.tsx`** — `await ensureLineupMaterialized(teamId, date)` before
  `getLineupForDate`. For any date the user browses, past or future. (A write on GET is
  already this codebase's pattern — the draft room resolves on read.)
- **`setLineupSlot`, `swapLineupSlots`, `autoSetLineup`** — materialize the date **before
  the capacity checks**, otherwise inherited occupants aren't counted and a slot can be
  overfilled.
- **`daily-ingest` cron** (`src/app/api/cron/daily-ingest/route.ts`) — after
  `processDueTrades()` / `processFaabBids()` / `processExpiredWaivers()` (so players
  awarded this morning get placed), for every team in every league: materialize
  **yesterday and today**. Runs at 09:00 UTC, before any NHL game, so this is the primary
  mechanism that gives scoring its rows; page views are the fallback. Log a count in the
  JSON response. Yesterday is included so a single missed cron run heals itself next
  morning — same reliability model as `ingestDate(yesterdayUTC())`, no deeper catch-up.
- **Interactive acquisition paths** — `await ensureLineupMaterialized(teamId, todayUTC())`
  after the transaction in `addPlayerToRoster`, `callUpToActive`, `activateFromIR`,
  `commissionerAddPlayer`, `commissionerMovePlayer` (when target is ACTIVE), and
  `forceProcessTrade` (for both teams). **Not** in `recordPick` (a 200-pick draft
  shouldn't do 200 schedule fetches; the first team-page view after the draft auto-fills
  the whole roster at once, ranked, which is a better default anyway), and not in the
  cron-driven FAAB/waiver/trade award paths (the cron's own materialize step follows them).

Clear:
- `dropPlayerFromRoster`, `sendToFarm`, `placeOnIR` (replace `placeOnIrClearingLineup`'s
  single-date delete with `clearLineupFrom`), `commissionerDropPlayer`,
  `commissionerMovePlayer` (when leaving ACTIVE), `addPlayerToRoster`'s drop branch,
  `executeTradeTransfers` (every PLAYER item, for `fromTeamId`), `startNewSeason` (all
  rows for the league's teams — mirror the `deleteLeague` line in `leagues/mutations.ts` ~L524).

### `autoSetLineup` change
Players **without** a game that day are no longer forced to BE. Two candidate tiers, each
sorted by points: with-game first, then no-game. Assign tier 1 across all slots, then tier
2 into whatever is still open. Everything else (locked players untouched, explicit `BE`
written for anyone not assigned) stays. This is what makes "Auto-Set" usable in
September and what stops a carried-forward lineup from having holes.

### Display (`page.tsx` `buildTierRows`)
No logic change needed — after materialization, `getLineupForDate` returns the rows and
the existing rendering is right. Update the `"BE"`-default comments to say "no row =
never placed; materialization runs first".

### Decisions already made (don't re-open)
- A change made on a future date applies from that date forward; earlier dates aren't
  touched. Explicit rows on a later date are their own snapshot and don't inherit
  changes made on an earlier date afterwards. This matches ESPN and is a known quirk.
- Auto-Set Today writes an explicit lineup for today that then carries forward — so a
  star benched today because he had no game stays benched tomorrow until you Auto-Set
  again or move him. Same as ESPN; "Auto-Set This Week" exists for exactly this.
- Dropping a player whose game already started forfeits his points today
  (`clearLineupFrom` deletes from today). The app currently allows the drop; ESPN would
  block it. Blocking the drop is a separate rules change — note it in PROGRESS.md's
  "Known gaps", don't build it here.
- Scoring functions (`getTeamScoreForPeriod`, `getTeamTopScorersForPeriod`,
  `getTeamSeasonStats`) keep reading rows as-is. No read-path self-heal — the cron
  (yesterday+today) plus page views cover it, matching the existing "cron missed a day =
  data gap" model.
- Existing 39 `LineupEntry` rows in "Experimenting" are wiped by Task 3's reset anyway.

### Verification
Script `scripts/persistent-lineup-check.ts` on a disposable league, using a far-future
date range (no NHL schedule published → nothing locked; `scripts/move-feature-check.ts`
uses `2031-02-10` for the same reason):
1. Team with C:1, LW:1, D:1, UTIL:1, BENCH:2; add a C, an L, a D, and a second C via `addPlayerToRoster`. Materialize D1 → assert C→C, L→L, D→D, second C→UTIL (position slots before UTIL), all by `getLineupForDate`.
2. Add a third C on D1 → materialize → assert he has **no row** (all eligible slots full), i.e. shows as bench.
3. `setLineupSlot` first C → `"BE"` on D1. Materialize D2 → assert D2 has the first C as explicit `BE` (sticky bench), the others carried forward, and the third C **auto-filled into the vacated C slot**.
4. Drop the L on D2 → assert his rows for D2 and later are gone and D1's row still exists. Materialize D3 → L slot open, nobody eligible (no L left) → stays Empty; no crash.
5. `setLineupSlot` on D5 with nothing explicit on D3/D4 → assert D5 was materialized from D2 **before** the write (row count on D5 = roster size minus never-placed), and that D3/D4 still have no rows (they'll inherit from D2 when viewed).
6. `autoSetLineup` for D6 → with no games on the date, assert slots are filled by points rather than everyone benched.
7. Capacity guard: with a slot full via inheritance only (no explicit rows on D7), attempt `setLineupSlot` into that slot on D7 → assert it throws "already filled".
Clean up by exact name. Then `npx tsx scripts/move-feature-check.ts` and
`scripts/score-check.ts` still pass (both exercise lineup/scoring paths).
Browser: a seeded test team's page on today's date shows players in slots rather than
all-bench, tomorrow's date shows the same lineup, and `+ Add` (from Players) followed by
returning to the team page shows the new player in an open slot.

---

## Checklist

- [x] Task 1 — stat ranges (#2)
- [x] Task 2 — header + notifications modal (#1, #3)
- [x] Task 3 — free agency gate (#5)
- [x] Task 3b — Experimenting roster reset + stale test league deleted (run once, record date in PROGRESS.md)
- [x] Task 4 — persistent lineups (#4)
