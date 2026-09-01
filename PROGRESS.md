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
- **Farm and IR are schema-ready but have no assignment mechanism.** `RosterSlot.slotType`
  supports ACTIVE/FARM/IR; nothing ever creates a FARM or IR row. Building "move to farm"
  needs the 80-GP waiver-exemption rule from DESIGN.md §2.3 — flagged to the user
  explicitly rather than bolted on as a naive toggle. Still undecided/unbuilt.

**UI**
- Dark app-chrome header, global nav is just Home/Leagues.
- Home page: dashboard of the user's teams across all leagues (`getTeamsForUser`).
- League pages sit under a nested layout (`src/app/leagues/[id]/layout.tsx`) that renders
  a league-specific sub-nav (My Team / League / Players).
- Players moved under league scope (`/leagues/[id]/players`) — **not globally browsable
  anymore**, on purpose: scoring is league-specific. Sortable ESPN-style stats table
  (every column clickable), position tabs, Pro Team filter, Available/All filter.
- Team roster page is now the **ESPN-style "main screen"** — see Lineups below;
  Skaters/Goalies tables carry lineup controls and stat-view switching directly, Farm
  section unchanged (always empty right now — see above).

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

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. Numbers are identical to before *today* because every league
  is currently seeded with `STARTER_SCORING` at creation — but the wiring is real now, not
  just modeled. This is the first point where per-league scoring customization (DESIGN.md
  §2.4/§2.10) would actually show up if a league changed its config. No UI exists yet to
  *change* a league's scoring config after creation.

## Known gaps, deliberately not built (ask before building)

- No matchups/scoring-against-an-opponent/standings — league home has no scores to show.
  Lineups are built (see above) but nothing reads them yet — a bench player and a starter
  score identically today since there's no matchup to differentiate "played" from "started."
- No draft, trades, FAAB, or waiver claims
- No farm/IR assignment (see above)
- Health/injury data, Watch List, schedule/"next game" column, stat projections — all
  explicitly skipped when building the players table; real ESPN features, no backing data
  or feature built for any of them here
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
