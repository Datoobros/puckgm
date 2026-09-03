# Progress — read this first

Snapshot of what actually exists, as of the commit this file was added in. `DESIGN.md` is
the game-rules/data-model spec; `ROADMAP.md` is the *original* 7-stage build plan written
before any code existed. Neither has been kept in sync with what actually got built — this
file is. Check `git log` for the real sequence and reasoning; commit messages in this repo
are written to be read later, not just at merge time.

## Live

- App: https://puckgm.vercel.app
- Repo: https://github.com/Datoobros/puckgm
- Database: Neon Postgres — **same instance for local dev and production**, no branch
  separation. Every script under `scripts/` cleans up by exact test-data name for this
  reason. Offered to fix via a Neon branch; not done.
- Auth: Clerk, **Development instance** (not Production). Works fine for a friends group,
  shows a small dev-mode notice. Production Clerk needs a custom domain first (Clerk
  verifies production instances via DNS) — deferred until the user buys one.

## Built and working

**Data pipeline** (DESIGN.md §4, ROADMAP.md Stage 1)
- NHL API client (`src/lib/nhl/client.ts`) — player search, landing, roster, schedule,
  boxscore. All free, unauthenticated, confirmed reachable from plain server-side `fetch`
  (WebFetch-the-tool gets blocked; real `fetch` doesn't).
- Player identity (`src/lib/players/identity.ts`) — internal IDs mapped to NHL source IDs,
  race-condition-safe under concurrent ingestion (see git history for the bug this fixed).
- Game ingestion (`src/lib/ingest/games.ts`, `daily.ts`) — raw stats only, points computed
  on read, never persisted (DESIGN.md §4.1). Full 2025-26 season backfilled: 1,312 games,
  ~52k stat lines, verified 0 errors on full re-run.
- Scoring engine (`src/lib/scoring/engine.ts`) — config-driven, verified exact against
  NHL's own season totals. `STARTER_SCORING` is the default; **leagues carry their own
  scoringConfig now** (see "Recent" below) — this is not the same as it being hooked up
  everywhere yet.
- Daily cron (`src/app/api/cron/daily-ingest/route.ts`) — scoped to only the teams that
  played that day, not all 32 every time (fixed a real Vercel timeout — see git history).

**Leagues, teams, rosters**
- Create/join/delete league (`src/lib/leagues/mutations.ts`). Roster composition locked
  forever at creation (no edit path exists — that's what makes "locked" true). Delete is
  commissioner-gated, with a fallback-to-earliest-team-manager rule for leagues that
  predate the `commissionerUserId` field.
- Add/drop players to a team's **active** roster only (`src/lib/rosters/mutations.ts`).
  Enforces the roster size cap and one-team-per-player exclusivity within a league. First
  real use of the append-only `TransactionLog`.
- **Farm and IR assignment is built** — see the dedicated section below.

**UI**
- Dark app-chrome header, global nav is just Home/Leagues.
- Home page: dashboard of the user's teams across all leagues (`getTeamsForUser`).
- League pages sit under a nested layout (`src/app/leagues/[id]/layout.tsx`) that renders
  a league-specific sub-nav (My Team / League / Players).
- Players moved under league scope (`/leagues/[id]/players`) — **not globally browsable
  anymore**, on purpose: scoring is league-specific. Sortable ESPN-style stats table
  (every column clickable), position tabs, Pro Team filter, Available/All filter.
- Team roster page is now the **ESPN-style "main screen"** — see Lineups below;
  Skaters/Goalies tables carry lineup controls, stat-view switching, and Farm/IR movement
  directly, plus a Farm section and an IR section (both interactive now — see below).

**Lineups** (DESIGN.md §2.4) — built directly into the team roster page, not a separate route
- `LineupEntry` read/write path: `src/lib/lineups/mutations.ts`, rendered inline on
  `/leagues/[id]/teams/[teamId]`. An earlier version of this shipped as its own
  `/lineup` page — folded into the team page per explicit user direction ("I want it done
  right on the main screen"), matching how ESPN does it. Draws from **ACTIVE roster only**,
  per the design doc's Roster-vs-Lineup distinction — farm/IR players never appear here.
- Slot values are single-letter position codes (`C`/`L`/`R`/`D`/`G`/`UTIL`/`BE`) chosen to
  match `Player.primaryPosition`'s actual stored codes exactly (see bug below) — not
  numbered slots like "C1"/"C2" (the schema comment's numbering was only illustrative) and
  not `RosterComposition`'s key names (`LW`/`RW`, set at league creation — those stay as-is;
  `capFor()` in `mutations.ts` bridges `L`→`comp.LW`, `R`→`comp.RW`). Capacity per slot is
  enforced by counting rows against the league's `rosterComposition`, not a DB constraint.
- Eligible positions render as a small tag beside each player's name (e.g. "C/UTIL") via
  `eligibleSlotsForPosition()`.
- Day-cycling (Prev/Next/date-picker) lives at the top of the team page and drives three
  things at once: which date's opponent/lock/lineup-slot column is shown, and — when the
  stats-view dropdown is set to **Daily** — which date's box score the stat columns show.
  The dropdown's other options are **season aggregates** (`2025-26`, `2026-27`), bucketed by
  calendar year in `src/lib/players/seasons.ts`; `getPlayerStatsAggregate` now takes an
  optional `dateRange` (filtered inside the `LEFT JOIN`, not a `WHERE`, so zero-game players
  still show up with real zeros instead of disappearing). Daily box scores come from a new
  `getPlayerDailyStats()` in `src/lib/players/rankings.ts`, reusing the same `PlayerStatsRow`
  shape so the existing column definitions needed no changes.
- Per-game lock (DESIGN.md §2.4: "a player locks when his own game begins, nothing else")
  compares wall-clock time to the NHL schedule's `startTimeUTC` for the player's team that
  date (`src/lib/lineups/schedule.ts`), not `gameState` — `gameState` flips to "PRE" a few
  minutes before puck drop, which would lock too early. Enforced both server-side
  (`setLineupSlot` throws) and in the UI (select disabled).
- `src/lib/nhl/schedule.ts` (`getDaySchedule`) is shared between the daily ingest job and
  the lineup feature's per-date team/game lookup, rather than each having its own fetch/parse.
- **Three real bugs found and fixed while verifying against seeded (and, once, live) data:**
  1. `Player.primaryPosition` is stored as NHL's single-letter code (`"L"`/`"R"`), not
     `"LW"`/`"RW"` — this is *why* lineup slots are named `L`/`R` (see above), and it's
     bridged explicitly in `mutations.ts`. **Not fixed elsewhere** — `PlayerStatsTable`'s
     forward filter (`FORWARD_POSITIONS = new Set(["C","LW","RW"])`) has the same mismatch
     and likely under-filters wingers; spun off as its own task, in progress separately.
  2. `<select defaultValue>` doesn't re-apply on a React re-render for an already-mounted
     uncontrolled element — after editing a lineup slot, the dropdown visually stayed on the
     old value until a hard reload, even though the write persisted correctly. Fixed with
     `key={value}` on the `<select>` to force remount when the slot changes.
  3. `getDaySchedule` threw on the NHL API's 404 for dates outside its published schedule
     window (e.g. cycling several seasons ahead) — crashed the whole page/mutation for what's
     actually a normal case ("no schedule published that far out yet"). Now treats 404 as
     zero games instead of an error.
- **Discovered mid-session**: after the first version of this feature was pushed to
  production, the live app already had a real `LineupEntry` for McDavid on the real "Qaiyam"
  team (not test data) — confirms the deployed feature is being used for real. Verification
  scripts in this session were careful to touch only far-future/safe test dates and clean up
  by exact row ID, never a blanket delete, per the shared-db convention.
- Nothing consumes lineups for scoring yet — a bench player and a starter score identically
  today since there's no matchup to differentiate "played" from "started." Real work for
  whenever matchups get built (see gaps below).
- **Row order and a Today shortcut** (feedback round after the first ship): Skaters/goalies
  rows sort by each player's *current lineup slot* — C block, then L, then R, then D, then
  UTIL, then Bench (G then Bench for goalies) — instead of roster-add order, so putting
  someone in a slot visibly moves them into that group. A "Today" link sits next to
  Prev/Next, hidden when already viewing today. Both `<select>` controls (the stats-view
  dropdown and the per-player slot picker) are forced to `bg-white text-black` — the native
  option popup ignores the app's dark theme and renders on the OS's own white background,
  so theme-driven white text was invisible against it.
- **Auto-set lineup** (`autoSetLineup` in `mutations.ts`, two buttons on the team page,
  owner-only, each behind a `confirm()` since it can silently overwrite a manually-curated
  lineup): recomputes a date's lineup from scratch for every *unlocked* active-roster
  player — ranks by **career-to-date fantasy points** (not season-scoped; sidesteps the
  season-boundary edge case below), fills C/L/R/D/G with the best-ranked eligible player who
  actually has a game that date, overflows the next-best remaining eligible skater into
  UTIL, and explicitly benches everyone else — including someone who was previously
  hand-picked into a slot but loses it to a higher-ranked player. Locked players (game
  already started) are left untouched and still count against that slot's capacity. "Auto-
  Set Today" always targets real today regardless of which date is being viewed; "Auto-Set
  This Week" targets today through +6 days. Verified against real data (not just seeded) on
  a safe future date with a real published NHL schedule — ranking, capacity, no-game
  exclusion, and UTIL overflow all came out correct; cleaned up by exact date afterward.
- **Known rough edge, not fixed**: `src/lib/players/seasons.ts` buckets seasons by calendar
  year (Aug 1 → Jul 31), so "today" can fall inside a season bucket that has zero ingested
  games yet (the *next* NHL season hasn't started) well before the real season begins. A
  strict "season points so far" ranking would go all-zero in that window; auto-set sidesteps
  it by ranking on the full career aggregate instead, but the **Daily/season stats-view
  dropdown** on the team page doesn't — it'll show honest zeros for a season bucket with no
  data yet, which is correct but could look broken without this context.

**Matchups and standings** (DESIGN.md §2.4, new `Matchup` model — `MatchupPeriod` existed but
had no team-vs-team pairing table until now)
- Regular season only, no playoff bracket (explicit product decision — a follow-up, not
  forgotten). Targets the **2026-27 season** specifically (also explicit — real season, so
  scores read honest 0-0 until it actually starts in ~late September 2026, rather than
  generating against the already-completed 2025-26 season just to have numbers to show).
- **Schedule generation is a one-time commissioner action**, not automatic: a form in the
  League page's Commissioner Tools card (`src/lib/matchups/mutations.ts`'s
  `generateSchedule`) takes a start date and week count, circle-method round-robins the
  league's teams (bye each week for odd team counts — leGM has 5 teams, so 4 play each week
  and 1 sits out), and refuses to run again once a schedule exists for that season. Start
  date defaults to **2026-09-29**, confirmed against the live NHL schedule API as the real
  first regular-season date — not a guess.
- **Scores are never persisted** — same DESIGN.md §4.1 philosophy as player points, now
  extended to team totals. `getTeamScoreForPeriod` (`src/lib/matchups/standings.ts`) sums
  fantasy points from `GameStatLine` for whichever players were actually **started**
  (non-BE `LineupEntry`) within a period's date range — this is the first place the
  Roster-vs-Lineup-vs-scoring chain actually connects end to end; a bench player really does
  score 0 for the matchup now. `getStandings` only counts periods whose `endDate` has
  passed (an in-progress week isn't a result yet); `getScoreboardForPeriod` shows any week,
  live or historical, with a `final` flag.
- New pages: `/leagues/[id]/standings` (W-L-T, PF/PA, sorted by win% then points) and
  `/leagues/[id]/scoreboard` (prev/next week navigation), both linked from `LeagueNav` —
  replacing its old comment explaining why they *couldn't* exist yet.
- **Real regression found and fixed while verifying**: `deleteLeague` never accounted for
  the new `Matchup`/`MatchupPeriod` rows — deleting a league with a generated schedule would
  have hit a foreign-key violation (`Matchup` references both `Team` and `MatchupPeriod`,
  neither cascades). Fixed by deleting `Matchup` → `MatchupPeriod` before the rest of the
  existing teardown order.
- **Real bug found and fixed on the Standings page**: `getStandings` always returns one row
  per team, even with zero periods created — so `standings.length === 0` never triggered the
  "no schedule yet" empty state; it silently rendered an all-zero table that looked like a
  real season already in progress. Fixed by checking `MatchupPeriod` existence directly
  instead of inferring it from the standings array.
- Verified end-to-end in a disposable test league (5 teams, 6 weeks): round-robin produced
  exactly the 10 unique pairings a 5-team season should have with zero repeats in the first
  cycle, standings/scoreboard correctly showed nothing until a period actually ended, and
  `getTeamScoreForPeriod` matched a known real per-game point total exactly (0.5, cross-
  checked against McDavid's actual 2026-01-15 box score) when given a real `LineupEntry`.
  Did **not** click "Generate Schedule" against the real leGM league — that's a one-time,
  irreversible-via-UI commissioner action the user should trigger themselves with their own
  choice of start date/week count, not something to commit on their behalf.

**Farm and IR assignment** (DESIGN.md §2.3/§2.6, `src/lib/rosters/mutations.ts`)
- Four moves: `sendToFarm` (ACTIVE→FARM, free/uncapped by the weekly limit), `callUpToActive`
  (FARM→ACTIVE, capped by `callupsPerWeek` and requires an open active slot), `placeOnIR`
  (ACTIVE→IR, capped by `irSlots`), `activateFromIR` (IR→ACTIVE, requires an open active
  slot — matches DESIGN.md's own worked example where activation is blocked until you send
  someone down first). All four gate on real ownership/roster-slot state and write a
  `TransactionLog` row (`SEND_DOWN` / `CALLUP` / `IR_MOVE`), same as every other roster
  mutation in this app.
- **Waiver claims are explicitly not built** — `sendToFarm` returns/logs `waiverExposed:
  true` when the demoted player has `careerNhlGp >= waiverGpThreshold` (80 by default) and
  the UI shows an "80+ GP" badge on eligible players, but nothing actually processes a claim
  from another team. That's DESIGN.md §2.9's distinct "demotion waivers" subsystem
  (`WaiverClaim` model already exists, still unused) — deliberately deferred so this pass
  stayed focused on the roster mechanic everything else depends on.
- **IR eligibility gates on real data, not a checkbox** — `Player.officialRosterStatus`
  used to be schema-only with nothing populating it. Investigated whether a reliable free
  source exists before building anything (the NHL's own public API has no injury/IR field
  at all): found ESPN's unofficial injuries feed
  (`site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries`), which reports a literal
  `"Injured Reserve"` status distinct from vaguer ones (`"Out"`, `"Suspension"`) — close to
  what DESIGN.md wants (gate on the real transaction, never on severity/prognosis).
  `src/lib/nhl/espn.ts` fetches it; `src/lib/players/injuries.ts`'s `syncInjuryStatuses()`
  matches entries onto existing players by **name + team** (ESPN gives no ID crosswalk to
  our NHL-sourced player IDs — team resolution goes through ESPN's numeric team id, since
  ESPN's own abbreviations differ from ours: `LA`/`NJ`/`SJ`/`TB`/`UTAH` vs our
  `LAK`/`NJD`/`SJS`/`TBL`/`UTA`). Recomputed every run, not hand-maintained — a player IR
  last run who isn't in this run's list gets cleared back to healthy, same philosophy as
  `careerNhlGp`/`currentNhlOrg`. Wired into the existing daily cron, unscoped (checks every
  team daily — one API call, cheap enough not to bother scoping to who played).
- **LTIR isn't distinguished from IR** — ESPN's feed doesn't carry that distinction, so both
  values gate the same way rather than inventing a fake distinction from unreliable data.
- **The 48h IR activation deadline (DESIGN.md §2.6) isn't auto-enforced** — deliberately.
  Activation is *possible* once official status clears; nothing forcibly moves a player off
  a manager's roster on a timer. Matches this app's existing pattern of every roster change
  being manager-initiated, not automated pressure.
- Verified end-to-end in a disposable test league against a **real** ESPN-flagged IR player
  (Evan Rodrigues): placing a healthy player on IR correctly threw, placing the real IR
  player succeeded, activating him while still officially IR correctly threw. Also verified
  farm capacity, the weekly callup limit (blocks a 3rd callup once the 2-per-week default is
  used), and the waiver-exposure flag (true for an 80+ GP fixture, false for a 0-GP one).
  Did not exercise this against the real leGM roster beyond a read-only render check — no
  destructive clicks against real team state.

**League settings editing** (DESIGN.md §2.10, `/leagues/[id]/settings`, commissioner-only)
- Exposes exactly the "between seasons, by vote" mutability tier: farm slots, IR slots,
  waiver GP threshold, callups/week, and the 13 scoring values `computeFantasyPoints`
  actually uses. The "locked at creation" tier (roster composition, league size, scoring
  format) is shown read-only on the same page with no inputs at all — there still isn't an
  edit path for those anywhere, which is what keeps "locked" true.
  `powerPlayPoints`/`shorthandedPoints` are deliberately left off the form even though
  they're real `ScoringConfig` fields — the engine documents them as a no-op (no data
  source yet), so exposing an input for them would let a commissioner set a value that
  silently does nothing.
- **No real voting system exists**, so "by vote" isn't enforced — access is commissioner-
  only (same as every other commissioner action in this app) and the page says outright
  that nothing stops a unilateral mid-season change; that's on the league, not enforced in
  code. Honest about the gap rather than pretending consent was collected.
- First real use of the `LeagueSettingsLog` model, which existed in the schema from the
  start of this project but nothing ever wrote to it. Each changed field gets its own row
  (`farmSlots`, `irSlots`, `waiverGpThreshold`, `callupsPerWeek`, or `scoringConfig.<field>`
  per changed scoring value) — only fields that actually changed value get logged, verified
  by submitting a no-op update and confirming zero new rows.
- **Two real regressions found and fixed while verifying, both the same shape as bugs found
  earlier this session**: (1) validation required every editable scoring field to be a
  present number, but the merge logic already treated `scoringConfig` as a partial update —
  `STARTER_SCORING` itself doesn't set `giveaways`/`takeaways`, so a legitimate partial
  config failed validation; fixed by only validating fields the caller actually supplied.
  (2) `deleteLeague` still didn't account for `LeagueSettingsLog` rows (the matchup-related
  version of this exact bug was fixed earlier in this session) — deleting a league with any
  settings-change history now hits a foreign-key violation instead of silently cascading;
  fixed by adding it to the teardown order. Both caught by the same disposable-test-league
  verification pattern used throughout this session, not by inspection.

**Waiver claims** (DESIGN.md §2.3/§2.9, `src/lib/waivers/mutations.ts`) — the other half of
demotion waivers; `sendToFarm` already flagged `waiverExposed`, nothing processed a claim
until now.
- `RosterSlot` gained two nullable fields: `waiverExpiresAt` (set on a FARM slot when
  `sendToFarm` demotes an 80+ GP player — presence + not-yet-past = "currently claimable")
  and `waiverClaimedAt` (set on the winning ACTIVE slot at award time, so a re-demotion
  within 48h of being claimed doesn't re-trigger `waiverExposed` — double jeopardy).
  `League` gained `waiverPriorityJson`, an ordered array of team IDs.
- **Explicit deviation from DESIGN.md §2.3's "reverse standings, updated weekly"** — the
  user overrode this directly. There's no draft feature yet to seed a real draft order from,
  and no season data yet to compute real standings from either. Instead: a rotating queue,
  seeded once per league as **reverse team-creation order** (a placeholder for the *seed*
  only — winning a claim sending that team to the back is the permanent mechanic going
  forward, not a fallback to be replaced later). `getOrInitWaiverPriority` lazily initializes
  it, same nullable-with-fallback pattern as `commissionerUserId`.
- **Claim window: 48 hours.** Resolution is cron-driven (`processExpiredWaivers`, called from
  the existing daily ingest route) rather than instant — **Vercel Hobby allows only one cron
  trigger per project per day**, so in practice a claim resolves at the next daily tick after
  48 hours have elapsed, up to ~24h of slop. Stated here plainly rather than promising
  precision the hosting plan can't deliver.
- **Award lands the player on the winning team's ACTIVE roster even if it's already at cap**
  — deliberate temporary overflow, confirmed with the user. Matches this app's existing
  IR-48h-deadline pattern: the constraint is real (shown in the UI) but nothing forcibly
  enforces it on a timer; a manager sorts out the overflow (send someone down) on their own
  time, same philosophy as every other roster change in this app being manager-initiated.
- New page `/leagues/[id]/waivers`: every currently-claimable player league-wide with a
  countdown and a Claim button (hidden for the team that just demoted him), plus the current
  priority order. A manager's own pending claim shows "Claim pending · Cancel" instead. The
  team page's Farm section got a small "claimable until `<time>`" badge for the same data,
  informational only — the actual claim action lives on the hub page, not scattered across
  every other team's roster page.
- A callup back to ACTIVE before a player's window expires voids any pending claims on him
  immediately (`voidPendingClaimsForPlayer` in `src/lib/rosters/mutations.ts`'s
  `callUpToActive`) — he's no longer sitting in limbo, so a claim against him is moot.
- Verified end-to-end in a disposable test league (3 teams): seed order, the "can't claim
  your own demotion" guard, two competing claims resolving to the higher-priority team even
  with that team's active roster already at cap, the losing claim clearing, priority
  rotating the winner to the back, the no-re-exposure exemption on an immediate
  re-demotion, a callup voiding a pending claim, and the organic-clear path (no claims —
  player just clears, no roster change). `scripts/waiver-claim-check.ts` keeps this as a
  runnable regression check, matching `roster-action-check.ts`'s pattern. Also checked both
  new UI surfaces in a real browser against a second disposable league, using the
  established `// TEMP:` hardcoded-userId technique to get past `auth.protect()` locally,
  reverted before commit (`grep -rn "TEMP:" src/` clean).

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. This is the first point where per-league scoring customization
  (DESIGN.md §2.4/§2.10) would actually show up if a league changed its config — and now a
  league can, via `/leagues/[id]/settings` (see above).

## Known gaps, deliberately not built (ask before building)

- No playoff bracket — matchups/standings are regular-season only for now (see above).
- No draft, trades, or FAAB/"the wire" (picking up an *unowned* player) — distinct from
  demotion waiver claims, which are now fully built (see below).
- Watch List, schedule/"next game" column, stat projections — still no backing data or
  feature built for any of these. (Injury/IR status is now real, via ESPN — see above; this
  line used to include it.)
- Contracts — explicitly deferred in the original DESIGN.md, revisit later or never

## Working conventions established this session

- Every commit message explains *why*, not just *what* — written for a future session to
  read, not just for the merge.
- Before claiming a UI change works: `npx tsc --noEmit` → `npm run build` → real browser
  check via `preview_start` against seeded data, not just "it compiles." Pages behind
  `auth.protect()` get a temporary hardcoded userId (marked `// TEMP:`), verified, then
  reverted — `grep -rn "TEMP:" src/` must be clean before every commit.
- Every throwaway test/seed script names its data distinctly and deletes only that name —
  the shared dev/prod database makes this load-bearing, not just tidy.
- Don't fake data that doesn't exist (injury status, projections, standings). Say plainly
  what's not built and why, rather than shipping a hollow version of an ESPN feature.
