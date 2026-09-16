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
- Create/join/delete league (`src/lib/leagues/mutations.ts`). Roster composition and schedule
  generation are commissioner-editable between seasons now (see "Commissioner tools" below) —
  only `positionMode` (SEPARATE vs COMBINED forwards) stays locked forever at creation. Delete
  is commissioner-gated (now via `isLeagueCommissioner`, covering co-commissioners too), with a
  fallback-to-earliest-team-manager rule for leagues that predate the `commissionerUserId`
  field.
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

**FAAB / the wire** (DESIGN.md §2.7/§2.9, `src/lib/faab/mutations.ts`) — the other unowned-
player acquisition path, distinct from demotion waiver claims (which only ever apply to an
*already-rostered* 80+ GP player someone just demoted).
- **Per-league opt-in, default off** (`LeagueSettings.faabEnabled`) — puckGM still has no
  draft, so the existing instant, free `+ Add` (`addPlayerToRoster`) is the only way a new
  league builds a roster at all. Every existing league keeps working exactly as before;
  nothing changes until a commissioner deliberately turns FAAB on for their league
  (`/leagues/[id]/settings`, new "FAAB / the wire" card). Turning it on blocks the instant
  path — `addPlayerToRoster` now throws if `faabEnabled` is true, pointing the manager at
  bidding instead. Dropping a player stays free/instant regardless, per DESIGN.md §2.5/§2.8
  — FAAB only ever gates the *pickup*, never the disposal.
- **Minimum and maximum bid are both per-league settings** (`faabMinBid`/`faabMaxBid`,
  `faabMaxBid` nullable = no cap beyond remaining budget) — this replaces DESIGN.md's
  original "$0 bids allowed" line, changed by explicit user direction earlier this session
  so a pickup always costs something real and no single bid can blow a team's whole budget
  unless the league chooses to allow that.
- **No schema migration needed** — `FaabBudget` and `FaBid` existed in the schema, unused,
  since the initial migration.
- Budget is only ever debited from `FaabBudget.remaining` at **award** time, never escrowed
  at submission. What actually gates a new bid is `getAvailableBudget` (`remaining` minus
  the sum of that team's other PENDING bids) — stops a manager placing simultaneous bids
  that would jointly exceed their budget if more than one won the same night.
- **Resolution is cron-driven**, piggybacked on the same daily route as
  `processExpiredWaivers` (Vercel Hobby's one-cron-trigger/day limit — same reasoning
  already documented for waivers). A bid has no expiry window like a waiver claim's 48h; it
  simply waits for the next daily tick, whenever that happens to be.
- **Ties broken by the current waiver priority order** (`getOrInitWaiverPriority`, reused as
  the one shared "priority" concept in this app) — but a FAAB win does **not** rotate that
  queue the way a waiver-claim win does. It's a read-only tie-break here, not the same
  mutating mechanic.
- **Award bypasses the roster cap**, same overflow-allowed philosophy as a waiver-claim
  award — confirmed with the user, consistent with this app's existing un-auto-enforced
  IR-48h-deadline pattern. Verified in `scripts/faab-check.ts`: a winning bid landed on a
  team's ACTIVE roster that was already at the 8-player league cap, taking it to 9.
- **Real regression found and fixed while verifying**: `deleteLeague` didn't account for
  `FaBid`/`FaabBudget` rows (they reference `Team` with no cascade, same shape as the
  Matchup/LeagueSettingsLog bugs found earlier this project) — deleting a league with any
  FAAB history would have hit a foreign-key violation. Fixed proactively by adding both to
  the teardown order before this ever hit a real league.
- Verified end-to-end in a disposable test league (`scripts/faab-check.ts`): instant add
  still works with FAAB off (no regression), throws once enabled, min/max bid enforcement,
  available-budget-blocks-overcommitment, higher bid wins a contested player, loser's
  budget untouched, cancel-before-processing needs no refund logic (nothing was ever
  debited), and the roster-cap-overflow case above. Also checked both new UI surfaces in a
  real browser (settings page FAAB card, Players page bid controls/available-budget
  strip/pending-bids list) against a second disposable league, using the established
  `// TEMP:` hardcoded-userId technique, reverted before commit
  (`grep -rn "TEMP:" src/` clean).

**Trades** (DESIGN.md §2.11, `src/lib/trades/mutations.ts`) — two-team only for this pass
(`TradeItem`'s per-item `fromTeamId`/`toTeamId` already generalizes to more, but the
proposer UI and validation don't yet).
- **Flow: propose → accept/decline → 24h review → process.** Proposing moves nothing — the
  counterparty must explicitly accept before a fixed 24-hour review window even starts.
  During that window the league's chosen governance model can veto it immediately, without
  waiting for the window to end.
- **Veto governance is a per-league setting** (`tradeVetoMode`): `COMMISSIONER` (matches
  every other governance action already in this app) or `VOTE` (any manager **not** party to
  the trade; a **strict majority** of those eligible voters vetoes it — confirmed with the
  user that the two trading managers never get to vote on their own trade).
- **Trade deadline is a per-league setting** (`tradeDeadline`) — DESIGN.md §2.10's "anytime"
  tier, not "between seasons": the commissioner can move it whenever, it just blocks *new*
  proposals after that date and doesn't touch trades already in flight. Called out with its
  own framing on the settings page rather than lumped in with the between-seasons warning
  the rest of the form carries.
- **Roster room is enforced, not bypassed**, unlike every other acquisition path in this app
  (waiver claims, FAAB) — an explicit user decision. If either side lacks room for what it's
  receiving when the window elapses, **the trade stays `UNDER_REVIEW` and is retried on every
  later cron run** rather than failing outright. Either trading manager, or the commissioner,
  can cancel a stuck trade at any time (`cancelTrade`) as the escape hatch — verified this
  actually un-sticks a trade in `scripts/trades-check.ts`.
- **The commissioner can force an already-accepted trade through immediately**
  (`forceProcessTrade`) — skips both the remaining review time and the room check (same
  overflow-allowed treatment as a waiver-claim/FAAB award), but only once the counterparty
  has actually accepted (`UNDER_REVIEW`, never a still-`PROPOSED` trade nobody agreed to).
- **A traded player keeps his current roster tier** (Active/Farm/IR) on arrival, checked
  against the matching cap on the receiving side — the room check (`wouldFitAfterTrade`) is
  the first mutation in this app to compute a net capacity delta across more than one team
  and more than one item at once; every prior cap check was single-team, single-item.
- **No re-exposure penalty within 24h of a trade** — same "just acquired, don't
  double-jeopardy him" logic already built for waiver-claim/FAAB awards
  (`RosterSlot.waiverClaimedAt`, 48h), now a second independent field/window
  (`tradeAcquiredAt`, 24h) checked by the same `sendToFarm` exemption logic.
- **Picks are tradeable now**, even though no league has any real `DraftPick` rows yet (no
  draft feature exists) — confirmed with the user to build it anyway. The mechanism is real
  (verified against a synthetic `DraftPick` fixture in `scripts/trades-check.ts`) but has
  nothing to select in the real UI until the draft ships. Being honest about that rather than
  claiming this is "tested against real picks."
- **`ORPHAN_FROZEN` is checked but not actually reachable yet** — `proposeTrade` blocks a
  trade involving an orphaned team per DESIGN.md §2.11, but nothing anywhere in this app ever
  sets a team to that state (confirmed zero references before this feature). The guard is
  real code, just inert until orphan-team detection itself gets built.
- `getAvailableBudget` (`src/lib/faab/mutations.ts`) now also subtracts FAAB promised away as
  the sending side of a team's own open trades, on top of pending `FaBid` amounts — otherwise
  a team could commit the same budget to a bid and a trade simultaneously. Verified in
  `scripts/trades-check.ts`.
- New page `/leagues/[id]/trades`: a propose-trade builder (pick a counterparty, two columns
  of checkboxes for players/picks/FAAB built from `getTradeableAssets`), "needs your
  response," "waiting on a response," "pending" (with Cancel/Veto/Force-through-now as
  applicable), and a resolved-trades history list.
- Verified end-to-end in a disposable 3-team test league (`scripts/trades-check.ts`):
  decline is terminal and moves nothing; a single non-participant veto in a 3-team `VOTE`
  league is already a majority and resolves instantly with no cron; a full trade (player +
  pick + FAAB) processes cleanly with slot types preserved and `tradeAcquiredAt` stamped; a
  room conflict stays pending instead of failing and completes once room opens up; cancel
  un-sticks a pending trade; commissioner force-process bypasses a full roster; the
  waiver-exemption window holds on a freshly-traded player; and FAAB double-commitment
  across a bid and a trade is blocked. Also checked the full UI flow in a real browser
  (propose as one manager, accept as the other via the `// TEMP:` technique, force-process as
  commissioner, settings page's new Trades card) — reverted before commit
  (`grep -rn "TEMP:" src/` clean).

## Playoff bracket

Started as "change how generating schedule works a little bit" — turned out to be a real
playoff bracket, folded into the existing one-time schedule-generation action rather than a
separate step.

- **Commissioner picks a bracket size at generation time**: None, 2, 4, or 8 teams.
  Deliberately scoped to powers of 2 — a non-power-of-2 bracket would need bye seeding, out
  of scope for this pass. Round count is *derived* (log2 of bracket size), not a separate
  input that could drift out of sync — "playoffs are the last 3 weeks" (the user's own
  framing) is what naturally falls out of picking an 8-team bracket, not a knob of its own.
- `generateSchedule` (`src/lib/matchups/mutations.ts`) appends that many extra
  `MatchupPeriod` rows (`isPlayoffs: true`) immediately after the regular season, created
  **empty** — there's nothing to pair until the regular season actually finishes.
- New `src/lib/matchups/playoffs.ts` fills them in round by round, **cron-driven** like
  every other once-daily mechanic in this app (waiver claims, FAAB, trades):
  `advancePlayoffsForLeague` seeds round 1 from final standings once the regular season
  ends (standard fixed bracket — `standardSeedOrder`'s recursive algorithm gives the real
  seeding pairs, e.g. 1v8/4v5/2v7/3v6 for an 8-team bracket, keeping 1 and 2 apart until the
  final), then advances each subsequent round from the previous round's winners once *that*
  period ends. A tied playoff matchup (impossible to leave unresolved, unlike the regular
  season) goes to the better seed — free, since the home team is always the better seed by
  construction. The loop self-heals through several rounds in one call if the cron was ever
  down for a stretch, rather than requiring one call per missed round.
- `getStandings` now excludes `isPlayoffs` periods — a playoff result must never count
  toward the regular-season win/loss record used for seeding.
- `getScoreboardForPeriod`/the Scoreboard page needed no structural change — playoff
  `Matchup` rows render through the exact same generic path as regular-season ones. It just
  gained a round label ("Quarterfinal"/"Semifinal"/"Championship") and seed numbers next to
  team names for playoff weeks. The Standings page gained a "Playoffs" card showing every
  round's matchups/scores in one place instead of clicking through individual weeks.
- **Two more real regressions found and fixed while verifying, same shape as before**:
  `deleteLeague` didn't account for `WaiverClaim` (missed when that feature shipped, before
  the FK-teardown pattern was established) or `LineupEntry` (missed since *lineups
  themselves* were built, near the start of this project — the oldest gap of this kind
  found yet). Both caught by real test-script cleanups hitting the FK violation, not by
  inspection, and both fixed in the same teardown order as every prior instance of this bug.
- Verified in `scripts/playoffs-check.ts` against the real DB: `standardSeedOrder` for
  n=2/4/8 against known-correct pairings; a 4-team bracket seeds correctly from a
  controlled, opponent-independent-scoring regular season (1v4, 2v3); a forced tie in one
  semifinal correctly advances the better seed, not the actual "loser" by matchup structure;
  the championship is built from the two winners with seeds carried forward, correctly
  waiting for the semifinal period to actually end first; `getStandings` never counts the
  playoff games. Also checked all three UI touchpoints in a real browser (the new bracket
  selector on Commissioner Settings, a playoff round's label and seeds on the Scoreboard
  page, the Standings page's new Playoffs card) and re-ran the waiver/FAAB/trades regression
  scripts afterward to confirm nothing else broke.

## UI re-theme + nav/league-home restructure

Full visual identity pass, requested because the app "looked black and ugly" — plus a
nav-order and information-architecture change specified directly by the user.

- **Navy / gold / white palette**, both light and dark (`src/app/globals.css`). Dark mode
  stays the pre-existing `prefers-color-scheme` media strategy — no toggle was requested or
  built. The old two-token setup (`--background`/`--foreground` only, Tailwind v4
  `@theme inline`) is now ten tokens (`--surface`, `--surface-tint`, `--border`, `--muted`,
  `--navy`, `--blue`, `--gold`, plus static `--navy-foreground`/`--gold-foreground` for text
  that always sits on those two fills). Every page now uses a single token-based class (e.g.
  `border-border`, `text-muted`, `bg-surface`) instead of hand-paired `dark:` variants — the
  CSS variable itself flips under the media query, so `dark:` classes are gone app-wide
  except the two places (`<select>`/`<input>` backgrounds) already documented as a
  deliberate native-dropdown-legibility workaround unrelated to theming.
- Fonts swapped from Geist to **Oswald** (headings/nav/`SectionLabel`) + **Inter** (body),
  via the same `next/font/google` pattern already in use.
- **Nav reordered and restructured**, per explicit user spec: League → My Team → Players →
  Trades → Scoreboard → Standings → Other Teams, then a right-aligned, gold, commissioner-only
  **Commissioner Settings** link. (Trades' position was an explicit assumption, flagged to
  the user before building — their spec named every tab except Trades, almost certainly an
  oversight rather than a removal request.) `LeagueNav` gained an `isCommissioner` prop,
  resolved once in `src/app/leagues/[id]/layout.tsx` via the existing `getLeagueCommissioner`.
- **League home is now a dashboard**, not a team directory: the team grid moved out entirely
  to a new `/leagues/[id]/teams` ("Other Teams") page; the old "Commissioner Tools" card's
  schedule-generation form and delete-league button moved into `/leagues/[id]/settings`
  (renamed "Commissioner Settings" to match the nav label) — so every commissioner action now
  lives in one place instead of being split across two pages. League home gained a **Recent
  activity** feed and a **Standings** summary card, and the **Waivers** page's entire content
  (claimable list + priority order, claim/cancel actions) moved in wholesale — the old
  `/leagues/[id]/waivers` route is deleted; its `actions.ts` stayed put and is imported by
  relative path from the new location, since server actions don't care where they're called
  from.
- New `src/lib/activity/feed.ts` (`getRecentActivity`) — the first place in this app that
  reads `TransactionLog` for display rather than just writing to it (the one prior read was a
  `count()` for the weekly-callup limit, not a listing). Scoped to *terminal* events only —
  `WAIVER_CLAIM` with `payload.event === "AWARDED"`, every `FAAB_WIN`, `TRADE` with
  `payload.event` in `PROCESSED`/`FORCED` — explicitly excluding submissions, proposals, and
  every non-completed trade state, plus every routine roster add/drop/callup/lineup-edit, per
  the user's own scoping call ("just the notable moves"). For trade rows it reuses
  `getTradesForLeague` (`src/lib/trades/mutations.ts`) rather than re-deriving team/item
  names from `TransactionLog.payload`, which only carries a bare `tradeId` for that type.
- **Real regression found and fixed while verifying**: `deleteLeague` never accounted for
  `WaiverClaim` rows (they reference `Team` with no cascade) — the same shape of FK-teardown
  bug already hit and fixed for `Matchup`, `LeagueSettingsLog`, `FaBid`/`FaabBudget`, and the
  trades tables, but missed for waivers specifically since that feature shipped before the
  pattern was established. Caught by a real cleanup script hitting the FK violation, not by
  inspection — fixed by adding it to the same teardown order.
- Verified in a real browser against a disposable two-team league seeded with one of each
  notable event (a waiver claim awarded, a FAAB win, a completed trade, plus one still-open
  claimable player): nav order and gold Commissioner-Settings visibility (commissioner vs.
  non-commissioner view), the activity feed's three entries with correct per-kind dot color
  (gold for waiver/FAAB, blue for trade — confirmed via computed style, not just visually),
  the Waivers section's live claim button, the Other Teams grid, and the Commissioner
  Settings page's moved schedule/delete-league controls — in both light and dark
  (`resize_window`'s `colorScheme` option). Re-ran the existing waiver/FAAB/trades regression
  scripts afterward to confirm the restructuring didn't break any of the three prior features.

## Draft (startup + rookie)

The last major roadmap item — both a one-time **startup draft** (a new league builds its
roster by drafting the real NHL player pool instead of instant-add) and a recurring
**rookie draft** (that year's actual NHL Entry Draft class), sharing one live draft room.

- **Real prospect data, sourced free**: `https://api-web.nhle.com/v1/draft/picks/{year}/all`
  (`getDraftClass`, `src/lib/nhl/client.ts`) returns every real NHL Entry Draft class back to
  1979 — name, position, drafting team, round/pick, junior league/club. No player ID field,
  so `ingestDraftClass` (`src/lib/players/draftClass.ts`) creates name/org/position-only
  `Player` stubs keyed by a synthetic `PlayerSourceId` (`source: "nhl-draft"`,
  `sourceId: "${year}-${overallPick}"`), tagged with five new nullable `Player` fields
  (`draftYear`, `draftRound`, `draftOverallPick`, `amateurLeague`, `amateurClubName`). Run
  manually, once a year after the real draft (`npx tsx scripts/ingest-draft-class.ts <year>`)
  — idempotent, matching `backfill-season.ts`'s convention. Ingested 2025 for real against
  production (224 real players).
  - **Known limitation, not solved**: a prospect ingested this way who later actually debuts
    gets a *separate* `Player` row from the existing boxscore/roster ingestion (which only
    keys off a real NHL numeric ID, `source: "nhl"`) — one stub, one real, no merge. No
    fuzzy-name matching built to fix this now; flagged for a future pass.
- **Live draft room, resolve-on-read clock**: this app has no live-update infrastructure
  (no websockets, no fine-grained cron) and Vercel Hobby cron only fires once a day, so the
  countdown isn't cron-driven. Instead `resolveDraftState` (`src/lib/draft/mutations.ts`)
  checks on every single read — every poll, every pick attempt — whether the current pick's
  deadline has passed, and if so autopicks and advances, **looping** so a stretch nobody was
  watching still catches all the way up to the true state in one call. `advanceDeadline`
  chains the next deadline from the *missed* deadline (not from "now") specifically when
  autopicking, so the loop can genuinely resolve several overdue picks per call — a subtle
  bug in the first draft of this function (always basing off "now") would have silently
  capped catch-up at one pick per call, defeating the point. A timely manual pick still gives
  the next team a fresh full window. This is the first client-polling UI in the app
  (`DraftRoom.tsx`, 3s interval) — called out as such, not hidden.
- **Order and mechanics**: `setUpDraft` builds every `DraftPick` row up front in snake order
  (round 2 reverses round 1, etc.), commissioner's choice of random shuffle or manual
  order — both, not either/or. Picks are real, tradeable `DraftPick` rows the moment
  `SETUP` exists, before the clock even starts — no changes needed to the trade system,
  which already only cares about `currentOwnerId`. `ROOKIE` setup rejects a season with no
  ingested class (honest error naming the ingestion command) rather than creating an empty
  pool.
- **Autopick ranking**: career fantasy points (`getPlayerStatsAggregate`, the same ranking
  `autoSetLineup` already uses) for a `STARTUP` draft. Falls back to real NHL draft position
  for `ROOKIE` — a freshly-ingested prospect has zero `GameStatLine` rows and would tie at 0
  points with every other prospect under the points ranking, so real draft order (lower
  overall pick = better prospect) is the closest honest proxy available.
- Drafted players land on the `ACTIVE` roster **past the roster cap** — same
  overflow-allowed philosophy as waiver-claim/FAAB awards, since a draft is supposed to fill
  every roster up to the round count, not fight the cap pick by pick.
- **UI**: Commissioner Settings gained a "Draft" card (`DraftSetupForm.tsx`) — draft
  type/season/rounds/timer/order form, a list of existing drafts with a Start Draft button
  per `SETUP` one. New `/leagues/[id]/draft` live room: on-the-clock card with a ticking
  countdown, a searchable pool with a Draft button (enabled only when the viewer's team is on
  the clock), and a recent-picks list tagging autopicked ones. `LeagueNav` gained a "Draft"
  link after Trades.
- **Real regression found and fixed while verifying, same shape as five times before**:
  `deleteLeague`'s teardown transaction didn't know about the new `Draft` model (it had
  `DraftPick` already, but not the `Draft` row itself) — fixed by inspection this time,
  before running the test script, recognizing the same FK-teardown gap that has hit
  `Matchup`, `LeagueSettingsLog`, `FaBid`/`FaabBudget`, `WaiverClaim`, and `LineupEntry`.
- Verified in `scripts/draft-check.ts` against the real DB: `ROOKIE` setup rejection with no
  ingested class; snake-order `overallPick` sequencing for a 4-team/2-round `STARTUP` draft;
  picks tradeable immediately via `getTradeableAssets`; turn enforcement; a manual pick
  landing on `ACTIVE` and leaving the pool; deadline chaining catching up through *exactly*
  as many picks as elapsed time allows (not all-or-nothing); full-draft completion past the
  cap; a real `ROOKIE` draft against the actual ingested 2025 class correctly ranking and
  drafting Matthew Schaefer (the real #1 overall pick) first. Also checked the full UI flow
  in a real browser across two disposable leagues: the settings-page setup form (manual
  order, round count, timer), starting the draft, the live room's countdown actually ticking
  down between polls, a real autopick sequence (a short timer let an entire 4-team/2-round
  draft autopick itself to completion while driving the browser, each pick correctly tagged
  AUTO in Recent Picks), and — in a second league with a long timer — a genuine manual pick
  through the actual UI (search box, click Draft), confirming no AUTO tag, the next team
  getting a fresh full countdown, and the picked player disappearing from the pool.

## Quality-of-life batch: league type, position mode, invites, search

Six requests came in together. Two were explicitly out of scope for this pass, by the
user's own choice: ELC-based waiver exemption (no free contract-data source exists —
DESIGN.md §2.12 already documents CapFriendly, the old source, was bought and taken
private, and PuckPedia isn't an API — same reason Contracts generally stays unbuilt) and
"give the commissioner more power" (explicitly deferred). The other four:

- **The load-bearing discovery**: the whole app treated "the season" as one global
  hardcoded constant (`CURRENT_SCHEDULE_SEASON`, `src/lib/matchups/constants.ts`) shared by
  every league — `League` had no season field of its own. Redraft literally can't work
  without a real per-league season, so this pass added `League.currentSeason Int` (backfilled
  to the old global's value, so every existing dynasty league is unaffected) and replaced
  every read of the constant with the league's own value. The one spot that actually iterated
  across leagues, `processDuePlayoffs` (`src/lib/matchups/playoffs.ts`), now joins back to
  `League` and compares per row instead of filtering by a shared scalar — different leagues
  can now genuinely be on different seasons. `CURRENT_SCHEDULE_SEASON` still exists, just as
  the *default* a brand-new league is created with.
- **League type: DYNASTY vs REDRAFT** (`LeagueSettings.leagueType`, locked at creation like
  `rosterComposition`/`scoringFormat`). DYNASTY is this app's original, only-ever-built model
  — unchanged. REDRAFT has no farm team: `farmSlots` is forced to `0` both at creation and in
  `updateLeagueSettings` (server-side, not just hidden in the form), and the Farm action
  button on the roster page is gated on `farmSlots > 0` (previously rendered unconditionally
  and would have hit an unhandled "Farm is full (0 max)" error — found while wiring this up,
  before it ever shipped). New `startNewSeason` (`src/lib/leagues/season.ts`, REDRAFT-only,
  rejected server-side otherwise) — commissioner-triggered from a new Season card in
  Commissioner Settings: cancels every non-terminal trade first (a wipe mid-flight would
  otherwise leave a `PROCESSED` trade with a silently-skipped item —
  `executeTradeTransfers` tolerates a missing `RosterSlot` but still marks the trade done),
  closes out every `RosterSlot` in the league (release to free agency — no waiver cleanup
  needed, since a farm-bound claim is structurally impossible at `farmSlots: 0`), then
  increments `currentSeason`. It deliberately doesn't auto-generate a new draft or schedule —
  the commissioner uses the already-built Draft and Schedule forms afterward, which now just
  naturally operate against the bumped season, same as a brand-new league.
- **Roster position mode: SEPARATE vs COMBINED forwards** (`RosterComposition.positionMode`
  + a new `F` field, locked at creation, a per-league choice — not a global change). All real
  logic lives in `src/lib/lineups/mutations.ts`: a second eligibility map for COMBINED
  (`F: ["C","L","R"]` replacing the three separate entries), `capFor` gains an `F` case, and
  `eligibleSlotsForPosition`/the auto-set-lineup position list are now parameterized by mode
  instead of one fixed global map. New-league creation gets a position-mode selector
  (`LeagueTypeAndRosterFields.tsx`) toggling between the two roster-input grids.
- **Real bug found and fixed while verifying**: `activeRosterCap` (`src/lib/rosters/
  mutations.ts`) did `Object.values(rosterComposition).reduce((sum, n) => sum + n, 0)` —
  once `positionMode` (a string, not a count) became a real field on that object, this would
  silently string-concatenate instead of sum for every COMBINED-mode league, corrupting the
  active roster cap everywhere it's used (trade room checks, the roster page's cap display,
  etc.). Fixed by excluding `positionMode` before summing. Three page components had the
  identical inline `Object.values(...).reduce(...)` duplicated instead of calling this
  shared helper — replaced all three with the (now-fixed) `activeRosterCap` call, so the fix
  only had to happen once. Two more spots displayed roster composition as text
  (`Object.entries(...).map(...)`) — filtered out `positionMode` and zero-count slots so a
  COMBINED league doesn't show "0 C · 0 LW · 0 RW · 6 F · ...".
- **Per-league invite links** (item 6 — "anyone can use the site, only invited people join a
  specific league"). Confirmed the real gap first: any signed-in user could already join any
  league with zero gate (`createTeamAction` had no membership/invite check at all — deleted
  entirely, since a dead-but-still-reachable Server Action is a live security hole, not
  inert code). `League.inviteCode String? @unique`, generated via `crypto.randomBytes(9)
  .toString("base64url")` (Node's `crypto`, confirmed no edge runtime anywhere in this app).
  Commissioner Settings gained an "Invite link" card (generate/regenerate — regenerating is
  the only revocation mechanism, and that's intentional: links are reusable and
  non-expiring, since `createTeam`'s existing one-team-per-manager-per-league check is the
  real guard, not the link). New `/invite/[code]` route + `joinLeagueAction` do the actual
  join. The league home page's non-member view now just points at needing a link — viewing a
  league dashboard you're not on is unchanged (still open to any signed-in user), only
  *joining* is gated now.
- **Free-agent search typeahead** (`PlayerSearchBox.tsx`, `/leagues/[id]/players`): a
  debounced (200ms, 2+ chars) client-side dropdown over a new lightweight
  `searchPlayersByName` (`src/lib/players/rankings.ts` — no stat aggregation, just
  name/position/team for ~8 matches) reusing the same `contains`-on-`fullName` search the
  page's exhaustive `?q=` path already used (already matches first *or* last name — "conn"
  already matched "Kyle Con**n**or" via last name before this). Clicking a result submits the
  real exhaustive search for that exact name. No player photos in this dropdown itself (see
  "Player headshots" below for where photos were later added). **Bug found while verifying**:
  the dropdown popped back open
  on landing on a results page (the `initialQuery` prop is 2+ chars after any search, and the
  fetch effect ran on mount) — fixed with a `hasTyped` ref so only actual typing triggers a
  new lookup, not the page's own pre-filled value.
- Verified in `scripts/qol-batch-check.ts` against the real DB: position-mode eligibility
  and `capFor` at the unit level; a REDRAFT+COMBINED league forces `farmSlots: 0` at creation
  and rejects a later edit trying to un-zero it; `activeRosterCap` returns a real number (not
  a corrupted string) for a COMBINED league; a 2-round startup draft, a pending draft-pick
  trade, then `startNewSeason` — confirming the trade gets cancelled, every roster slot
  closes out, `currentSeason` advances by exactly 1, and a fresh startup draft for the new
  season sees both previously-drafted players available again; the full invite-link
  lifecycle (generate, resolve, commissioner-only regenerate, old code stops resolving, a new
  manager joins through it). Re-ran every existing waiver/FAAB/trades/playoffs/draft
  regression script afterward to confirm dynasty/separate-mode leagues are byte-for-byte
  unaffected — two of those scripts (`faab-check.ts`, `trades-check.ts`) needed their own
  `CURRENT_SCHEDULE_SEASON` references swapped for a local season constant, since "the
  season" is no longer one global value; both had been silently failing on an unrelated
  assertion for that exact reason and now pass end to end, including their own cleanup.
  Also checked all of it in a real browser: the new-league form's league-type/position-mode
  toggles actually swapping the roster-input grid, Commissioner Settings' Season and Invite
  Link cards, generating a link and joining through it as a second manager, and the players-
  page typeahead (matches appearing, a click submitting the exact-name search, the "View N
  results" link).
- **Known pre-existing limitation, unrelated to this batch, found while re-running the full
  regression suite**: `scripts/roster-action-check.ts` (calls real Server Actions directly
  via `tsx`, not just their underlying lib functions) fails with a `server-only` import error
  from inside Clerk's `auth.protect()` — confirmed via `git stash` that this fails identically
  against the last commit, before any of today's changes, so it's a pre-existing tsx/Clerk
  interop issue, not a regression. Not fixed here — out of scope for this batch.

## Commissioner tools: co-commissioners, team management, roster overrides, draft/schedule editing, divisions

Modeled on a generic fantasy platform's Commissioner Tools admin panel (~20 tools the user
screenshotted across League Membership, Draft, League & Scoring, Roster, Schedule & Standings,
Misc). Confirmed with the user up front: roster composition and schedule generation — both
"locked forever"/"one-time" by the original design (DESIGN.md §2.10) — become
commissioner-editable; Divisions and Co-commissioners are new this pass; Keepers and league
polls/voting are explicitly out of scope, not deferred; a commissioner directly editing
someone else's roster is a full override (bypasses cap/waiver/FAAB checks, same precedent as
the existing waiver-award/FAAB-win/force-process overflow-allowed behavior).

- **Co-commissioners** (`Team.isCoCommissioner Boolean @default(false)`). New
  `getLeagueCommissioners`/`isLeagueCommissioner` (`src/lib/leagues/mutations.ts`) replace
  every prior single-`commissionerUserId`-equality check across leagues, season rollover,
  draft, matchups, and trades. `setCoCommissionerAction` is gated to the **primary**
  commissioner only — a co-commissioner can't promote/demote themselves or anyone else, so one
  can't lock out the founder. **Conflict-of-interest guard found during planning review**:
  without it, a co-commissioner who's a manager of either side of a specific trade could
  veto-kill or force-through their own trade, bypassing the 24h review entirely — both
  `castTradeVeto` (COMMISSIONER mode) and `forceProcessTrade` now reject a caller who's a party
  to that trade, even if they're otherwise a legitimate commissioner. This broke one existing
  regression assertion in `trades-check.ts` (its sole commissioner was also a trade party) —
  fixed correctly by granting a genuine third-party team co-commissioner status for that test,
  preserving what the assertion was actually proving.
- **`ORPHAN_FROZEN` finally closes the gap flagged earlier in this file** (see the trades
  section above: "checked but not actually reachable yet"). New `setTeamManager(..., {
  newManagerUserId } | { orphan: true })` is what actually sets it now. Making that meaningful
  required auditing every roster-touching mutation in the app, not just trades: `addPlayerToRoster`,
  `dropPlayerFromRoster`, `sendToFarm`, `callUpToActive`, `placeOnIR`, `activateFromIR`
  (`src/lib/rosters/mutations.ts`), `setLineupSlot` (`src/lib/lineups/mutations.ts`),
  `submitWaiverClaim` (`src/lib/waivers/mutations.ts`), and `submitFaBid`
  (`src/lib/faab/mutations.ts`) all now reject a frozen team. **Also caught in review**:
  `processExpiredWaivers` and `processFaabBids` (the daily cron resolvers) now filter winner
  selection to `state: "ACTIVE"` teams — a team frozen *after* submitting a claim/bid but
  *before* the cron runs must not still win; it resolves CLEARED/LOST instead, verified against
  the real DB.
- **Team claim links** — `Team.claimCode String? @unique`, single-use (cleared on claim), via
  `regenerateTeamClaimCode` + a new `/invite/team/[code]` route. This is what makes
  `addTeamAsCommissioner` coherent: a commissioner-added placeholder team starts owned by the
  commissioner administratively, then gets a claim link to hand to the real manager. Rename,
  set/clear division, reassign, orphan, and delete (only when the team has zero history —
  `teamHasHistory` checks `RosterSlot`, `DraftPick`, `TradeItem`, `FaBid`, `FaabBudget`,
  `WaiverClaim`, `LineupEntry`, `TradeVeto`, and `Matchup` as home or away, since schedule
  generation alone can already put a "fresh" team into `Matchup` rows) round out per-team
  management, all in a new "Teams & managers" card in Commissioner Settings.
- **Real bug found during browser verification, fixed**: `setTeamManager`'s
  duplicate-manager guard (`src/lib/leagues/mutations.ts`) queried for *any* team in the league
  already managed by the target user, but didn't exclude the team being reassigned itself.
  Orphaning leaves `managerUserId` untouched (only `state` changes), so reassigning an orphaned
  team back to its own already-orphaned manager — the ordinary "I orphaned this by mistake, undo
  it" recovery path — hit a false "that person already manages a team" rejection and silently
  no-opped. Fixed by excluding `id: input.teamId` from that lookup; the existing regression
  script had only ever exercised reassign-to-a-*different*-manager, so it never caught this —
  added a dedicated assertion for the self-reassign case to `commissioner-tools-check.ts`.
- **Second real gap found during browser verification, fixed**: the commissioner
  roster-override controls (`!isOwner && isCommissionerViewing`, `src/app/leagues/[id]/teams/
  [teamId]/page.tsx`) were wired into the Active-roster table but never added to the Farm or IR
  list rendering, which only ever had `isOwner`-gated buttons. A commissioner viewing another
  team's page could add a player and see them land on Active, Farm, or IR, but had no UI path
  to call up a farm player, activate someone off IR, or move/drop a player already sitting in
  either list. Added the same Active/Farm/IR/Drop button set (via `commissionerMovePlayerAction`/
  `commissionerDropPlayerAction`) to both list renderers, verified live for all three states.
- **Direct roster overrides** — `commissionerAddPlayer`/`commissionerDropPlayer`/
  `commissionerMovePlayer` (`src/lib/rosters/mutations.ts`) skip the cap-check branch entirely,
  same "overflow allowed" precedent as waiver/FAAB awards. A new debounced search box
  (`CommissionerAddPlayerBox.tsx`, reusing the free-agent typeahead's `searchPlayersAction`)
  plus Active/Farm/IR/Drop buttons render on any team's page when viewed by a commissioner who
  isn't its owner. Still blocked by `ORPHAN_FROZEN` — the commissioner reassigns/un-freezes a
  team first if it needs roster surgery.
- **Draft settings become editable while `SETUP`** — `updateDraftSetup` diffs `DraftPick` rows
  in place (update existing rows' `round`/`overallPick`, add/remove only the delta) instead of
  delete-and-recreate, because `TradeItem.draftPickId` has no cascade: deleting a pick ever
  referenced by a trade (any trade state, not just pending) would throw an FK violation. Both
  `updateDraftSetup` and a new `cancelDraftSetup` reject outright once *any* pick in that draft
  has ever appeared in a `TradeItem`. New `LeagueSettings.draftPickTradingEnabled` (default
  `true`) lets a commissioner turn off pick trading entirely; `resetDraftPickOwnership` reverts
  every *unused* traded-away pick back to its original owner league-wide (already-drafted picks
  are history, untouched).
- **Roster composition and schedule generation are no longer locked forever** — both move to
  the same "between seasons, by league vote (unenforced — no voting system exists)" tier as
  farm/IR/waiver settings already were. `positionMode` is the one field that stays locked even
  as the rest of `rosterComposition` opens up — `updateLeagueSettings` rejects any attempt to
  change it, and re-enforces the SEPARATE/COMBINED zero-invariants on the editable numeric
  fields (same check `parseRosterComposition` already does at creation). New `resetSchedule`
  deletes every `Matchup`/`MatchupPeriod` for a season so the commissioner can regenerate —
  refused once any period's `endDate` has passed, since standings are computed live from stored
  `Matchup` rows with no separate results table, so a completed week's history would simply
  vanish rather than just reset.
- **Divisions** (`Team.division: String?`) are deliberately display/standings-grouping only —
  not wired into schedule generation (round-robin still covers every team regardless) or
  playoff seeding (still overall standings). `getStandings` includes `division` per row; the
  Standings page groups by it when any team has one set, otherwise renders flat as before.
- Verified in a new `scripts/commissioner-tools-check.ts` against the real DB (co-commissioner
  grant/revoke and the conflict-of-interest guard; orphan freezing every roster-touching
  mutation including cron-resolution-time claims/bids; the self-reassign fix; add-team → claim
  link → a second identity claiming it; delete-team's history gating; draft edit/cancel
  diffing and the traded-pick lock; the pick-trading toggle; reset-pick-ownership; roster
  composition edit with `positionMode` still rejected; schedule reset's past-week guard;
  division grouping not disturbing unrelated mechanics) plus every pre-existing regression
  script re-run clean. Also checked live in a real browser end to end: cancel-draft, add
  team, claim-link generation and claiming as a second identity, co-commissioner toggle,
  orphan → reassign (including the bug above), invite-link generation, the commissioner
  roster-override controls across Active/Farm/IR (including the second bug above), and
  division grouping on Standings.

## Native form control theming, schedule visibility, player headshots

Three unrelated small-to-medium requests bundled together in one pass.

- **Native `<select>`/`<input type="date">` popups now render dark in dark mode.** Every one
  of these controls across the app had been hardcoded `bg-white text-black` (`globals.css`
  had no `color-scheme` property set, so browsers rendered the *option popup* — not just the
  closed box — using the OS's light-mode chrome regardless of the page's own dark theme; two
  components even carried comments documenting this as a deliberate past fix, not an
  oversight). Setting `color-scheme: light` / `color-scheme: dark` on `:root` (mirroring the
  existing `prefers-color-scheme` media-query pattern) makes browsers render the popups
  themselves with matching native dark chrome, which is what actually let every occurrence
  switch to the theme's `bg-surface`/`text-foreground` tokens instead of white/black without
  reintroducing the invisible-text bug the white/black hack was there to prevent.
- **Team page: next-two-matchups widget + full "My Schedule" page.** New
  `getTeamSchedule(teamId, leagueId, season, scoringConfig)`
  (`src/lib/matchups/standings.ts`) returns one row per `MatchupPeriod` for a team — opponent,
  home/away, and (only once that period's `endDate` has passed, same rule `getStandings`
  uses) the final score. A regular-season period with no `Matchup` row for the team becomes a
  `bye: true` row (see `generateRoundRobinRounds`'s odd-team-count handling below); a playoff
  period the team never reached is omitted rather than shown as a bye — those aren't the same
  thing. The team page shows the next two upcoming rows (or "Season complete.") with a link to
  the new `/leagues/[id]/teams/[teamId]/schedule` page, which lists the whole season.
- **Scoreboard: view any team's full-season schedule instead of one week at a time.** A new
  team selector (`TeamScheduleSelect.tsx`) on the existing Scoreboard page switches between
  the original week-by-week view and a per-team view built on the same `getTeamSchedule`
  query — reused, not duplicated, across the team page, the new schedule page, and this.
- **How odd team counts are handled in schedule generation** (asked directly, documented
  here since it wasn't written down anywhere): `generateRoundRobinRounds`
  (`src/lib/matchups/mutations.ts`) is the standard circle method — an odd team count gets a
  phantom "bye" slot injected before pairing, and whichever real team lands opposite it in a
  given round simply gets no `Matchup` row that week. Nothing else about generation changes;
  every other team still gets a normal pairing that round.
- **Player headshots** — `Player.headshotUrl String?` (migration), populated from the NHL
  landing/roster endpoints' own `headshot` field (a ready-to-use CDN URL — confirmed real via
  a direct API check, not constructed by hand from team/season/playerId, which isn't stable
  across trades and retirements). `upsertPlayerFull` (`src/lib/players/identity.ts`) now
  captures it alongside the existing `currentNhlOrg`/`careerNhlGp` derived-and-refreshed
  fields — same tier, refreshed the same way, via the existing `syncTeamRoster`/
  `syncAllRosters` roster sync, no new ingestion path needed. New `PlayerHeadshot.tsx`
  (client component — needs `onError` state to swap in a blank-silhouette SVG when a player
  has no photo yet, which is expected for rookie-draft-class prospects and anyone not on a
  current NHL roster, not treated as an error) is wired into the three surfaces asked for:
  the Players page table, the team roster page (Active/Farm/IR), and the trade builder's
  asset checklists. Free-agent/commissioner search typeahead dropdowns were left as-is —
  out of scope for this pass.
- **Real external-API constraint hit while backfilling, worth knowing for next time**: a
  one-time backfill run against all 32 NHL teams to populate `headshotUrl` for existing
  players hit NHL's (unauthenticated, undocumented) API's rate limit repeatedly — even with
  2s pacing between teams — and only completed for ~135 of ~1,300 players before this pass
  ended. This is **not a code bug**: the sync mechanism itself is confirmed correct (every
  team that didn't get rate-limited synced cleanly, verified live with both a real photo and
  the silhouette fallback rendering correctly side by side). The remaining players will pick
  up their headshot the normal way, via the existing daily-cron roster sync, without any
  further action — this was a one-time bulk backfill hitting a burst limit, not a gap in the
  ongoing sync path.

## Team page redesign, co-managers, draft picks tab, team logos

Prompted by a screenshot of a generic ESPN-style team page — restyle the team roster page to
loosely match it, drop the reference's Team Settings gear/Keepers link/Trade & Acquisition
Limits/draft-scheduling banner (all confirmed explicitly out of scope), and replace that banner
slot with the schedule-preview widget from the previous pass. Clarifying two elements the user
did want turned this from "mostly UI" into three real features.

- **Co-managers — NOT the same as co-commissioners.** `isCoCommissioner` (see the commissioner
  tools section above) grants league-wide commissioner power to whoever manages a flagged
  team; this is a different, narrower concept — a team's primary manager sharing full
  operational control of *that one team* with a second real person, via `Team.
  secondManagerUserId` + a single-use `secondManagerClaimCode` (same claim-link pattern as the
  existing per-team `claimCode`, kept as a separate field since claiming one sets
  `managerUserId` and the other sets `secondManagerUserId` — both can be pending on the same
  team at once). New `isTeamManager(team, userId)` / `managerOrCoManagerWhere(userId)` helpers
  (`src/lib/leagues/mutations.ts`) replace every bare `team.managerUserId === userId` check
  across the app — every roster/lineup/waiver/FAAB/trade/draft-pick mutation
  (`src/lib/rosters`, `lineups`, `waivers`, `faab`, `trades`, `draft/mutations.ts`), the
  one-team-per-league dedup in `createTeam`/`claimTeam`/`setTeamManager`, `getTeamsForUser`
  (so a co-manager's teams show up on their own dashboard), and ~10 page-level "find my team"
  lookups — same sweep shape as the `isLeagueCommissioner` rollout, same precedent reused
  deliberately. Rename/division/logo/invite-management stay primary-manager-only (confirmed);
  no commissioner-power inheritance even on a co-commissioner-flagged team (confirmed); the
  one-team-per-league dedup applies to co-managers too, so one person can't quietly run two
  rosters in the same league (confirmed). **Edge cases caught in review**: `setTeamManager`
  (both its orphan and reassign branches) and `claimTeam` all now clear a stale co-manager —
  without this, a co-manager would silently retain full control of a team after its primary
  slot changed hands to someone unrelated. New route `/invite/team/co-manager/[code]` +
  `claimCoManagerAction`, invite/remove UI lives on the team's own page (gated on the primary
  manager specifically, never a co-manager), not in Commissioner Settings — this is a per-team
  relationship the commissioner has no say in.
- **Team page redesign** (`src/app/leagues/[id]/teams/[teamId]/page.tsx`): a header identity
  card (logo, name, Dynasty/Redraft badge, "Managed by X" / "Managed by X & Y", the
  co-manager invite/remove controls), the schedule-preview widget restyled into a boxed panel
  in the slot the reference used for its draft banner, and three real tabs — **Stats**
  (unchanged Skaters/Goalies/Farm/IR content), **Schedule** (the full-season list, now
  extracted into a shared `src/components/TeamScheduleList.tsx` so the dedicated `/schedule`
  page and this tab render identically without duplicating markup — also now reused by the
  Scoreboard page's per-team view), and **Draft Picks** (new — added mid-planning at the
  user's request, not originally scoped). Reference elements explicitly dropped: Trending/News
  tabs (no data source for either), Team Settings gear, Keepers link, Trade & Acquisition
  Limits.
- **Draft Picks tab** — new `getTeamDraftPicks(teamId)` (`src/lib/draft/mutations.ts`), a
  read-only list of every pick a team currently owns (own or acquired via trade, used or not),
  reusing `DraftPick`'s existing schema — no new data model needed.
- **The daily-lineup date picker became a real multi-day clickable strip** (confirmed as
  actual UI work, not just a restyle) — new `DateStrip.tsx` shows ~5 days at once, click any
  directly, chevrons scroll the window one day at a time, plus a themed native date input for
  jumping anywhere. Replaces the old one-day-at-a-time Prev/Next/Today row on the Stats tab
  only (meaningless for the season-aggregate view). `shiftDate`/`todayUTC`/`DATE_RE` moved to
  a new `src/lib/dates.ts` so both the page and the client-side strip share one implementation
  instead of two copies drifting apart.
- **Team logos, real upload via Vercel Blob** (confirmed over storing images directly in
  Postgres) — `Team.logoUrl`, client-side resize to ~200px before upload
  (`src/lib/images/resizeImage.ts`, canvas-based, browser-only), a Server Action
  (`setTeamLogoAction`) that uploads the already-resized image and passes the resulting blob
  URL into `setTeamLogo`, which validates the URL's host is actually on Vercel Blob's own
  domain before persisting — this field renders as `<img src>` on every viewer's team page, so
  an arbitrary caller-supplied URL is never trusted. New `TeamLogo.tsx` mirrors
  `PlayerHeadshot.tsx`'s load-failure-fallback shape exactly (silhouette/crest placeholder).
  **Confirmed working end-to-end in production** (2026-09-07) — this app had no file storage
  of any kind before now, so getting a real Vercel Blob store correctly wired up took a few
  rounds of dashboard-only troubleshooting (no code changes): OIDC federation wasn't actually
  active for the project (fixed by using a static `BLOB_READ_WRITE_TOKEN` instead), the first
  store was created in Private mode and `access: "public"` mode is picked permanently at
  creation and can't be changed (fixed by creating a new store, `puckgmblob`, as Public), and
  the env var briefly held a stale/malformed value — once literally still pointing at the
  deleted private store, then pasted with the `.env.local`-panel's literal quote characters
  included, which are file syntax and not part of the real token. A real logo upload against
  the live site succeeded once `BLOB_READ_WRITE_TOKEN` held the new public store's raw,
  unquoted token and a redeploy picked it up (env var edits don't apply to an
  already-running deployment). Local `.env`/`.env.local` still has no token, so this still
  can't be exercised from a local dev session — production is the only place it's been used.
  Everything else in this pass (co-managers, the redesign, the Draft Picks tab) had no such
  dependency and was fully verified earlier.
- Verified in a new `scripts/co-manager-check.ts` against the real DB: the full invite → claim
  → operate → remove lifecycle; a co-manager's parity across add/drop/lineup/farm/waiver
  claim/FAAB bid/trade proposal; rejection from every primary-only action (rename, division,
  logo, re-invite, self-removal); the one-team-per-league dedup from both a co-manager's and a
  primary manager's side; `setTeamManager`'s and `claimTeam`'s co-manager-clearing; `getTeamDraftPicks`
  for both an own and an acquired-via-trade pick, used and unused. Every pre-existing
  regression script re-run clean afterward. Checked live in a real browser: the redesigned
  header, the restyled schedule panel, all three tabs, the co-manager invite/claim/remove flow
  end to end as two different identities, and the date strip's click-through and
  window-shift.

## Click-to-move lineup/roster UI

Replaces the old `<select>`-dropdown lineup-slot picker (`LineupSlotSelect.tsx`, deleted) with
an ESPN-style click-to-select-then-click-to-place interaction, per a reference screenshot the
user provided and two rounds of clarifying questions. First genuinely new client-interaction
pattern in this codebase — nothing before this used `useState` for a multi-step selection flow.

- **Scope, confirmed with the user**: spans all three roster tiers on the team page — starting
  lineup slots (C/L/R/D/UTIL/G), Bench, and IR — for the primary manager or co-manager. Farm is
  untouched, keeps its existing Call Up/Send Down buttons.
- **Interaction**: every eligible player row shows a solid "Move" button. Clicking it selects
  that player; every legal destination row switches to an outlined "Here" button; clicking one
  completes the move. Clicking Move again cancels. Non-destination rows show no button at all
  while a selection is active (matches the reference screenshot's behavior, not a gray-out).
- **Empty slots as real destinations**: unfilled position-slot capacity renders as clickable
  "— Empty" placeholder rows (e.g., a second "D — Empty" row when only 1 of 2 D slots is
  filled). Bench is uncapped in this app (`capFor("BE", comp)` already returned `null`), so
  there's always exactly one generic empty "Bench" row as a destination rather than requiring a
  swap with a specific existing bench occupant.
- **True two-way swaps, not "bump to bench"**: dropping a mover onto an occupied slot swaps the
  two players — the displaced occupant lands in the *mover's own former slot* (which could be
  Bench or another starting slot), verified eligible for them first. New
  `swapLineupSlots` (`src/lib/lineups/mutations.ts`) does both writes in one transaction, reusing
  a new shared `loadAndValidateLineupMove` gate helper that `setLineupSlot` was refactored to
  use as well (same checks as before, no behavior change for the existing function).
- **IR is a real destination tier**: healthy-but-still-IR-tagged active players can be moved
  straight onto IR (still gated on the real `officialRosterStatus` check, no bypass); IR players
  who've cleared can be activated into an empty slot, into Bench, or by swapping into an
  occupied slot — which always bumps the displaced occupant to Bench specifically (not a real
  IR-for-IR swap, since an IR player has no lineup slot of his own to hand back). New
  `placeOnIrClearingLineup`/`activateFromIrIntoSlot` (`src/lib/rosters/mutations.ts`) compose the
  existing `placeOnIR`/`activateFromIR` with the lineup-side write — two sequential mutations,
  not one cross-table transaction (documented limitation: if the second leg fails, the player
  ends up activated-but-benched rather than corrupted, matching `autoSetLineup`'s existing
  tolerance for partial-loop failure).
- **Real bug found and fixed while building this**: lineup-slot capacity checks
  (`setLineupSlot`/`swapLineupSlots`) counted *every* `LineupEntry` row for a date/slot,
  including stale rows left behind when a player was sent to Farm/IR without that row ever being
  cleaned up (only the new IR path bothers to clean up after itself). A slot could read as full
  from a player who'd long since left the active roster. Fixed at the root — both capacity
  checks now filter to players currently on the ACTIVE roster — rather than chasing every
  mutation that changes roster tier.
- New `src/app/leagues/[id]/teams/[teamId]/RosterMoveBoard.tsx` (client component, owns the
  `selected` state) and `moveTypes.ts` (shared plain types, no directive). `page.tsx` gained
  `buildTierRows()`, computing every row (real + synthetic) and every eligible player's move
  options entirely server-side; the client component only ever looks up precomputed options by
  row key, no eligibility logic lives on the client. One dispatching Server Action,
  `moveTeamPlayerAction`, picks the right mutation(s) based on source tier and destination kind.
- Verified in a new `scripts/move-feature-check.ts` against the real DB: a true swap in both
  directions; the stale-LineupEntry capacity fix (a farmed player's leftover row no longer
  blocks a real teammate from taking that slot); `placeOnIrClearingLineup` clearing that date's
  entry; `activateFromIrIntoSlot` into an empty slot and into an occupied one (confirming the
  occupant lands on Bench); activation correctly blocked with no corruption when the active
  roster is already full. Every pre-existing regression script re-run clean afterward (the one
  failure, `roster-action-check.ts`, is the same pre-existing tsx/Clerk `server-only` import
  issue already documented above, unrelated to this change). Checked live in a real browser
  against the real "QTest" test team: Move → Here filling an empty C slot, then a genuine bench
  player swapping into the now-full C slot with the displaced player correctly landing on
  Bench — both moves persisted through a real page reload.

## Trade builder stats, review screen, and counter-offer

Second half of the same approved plan as the Move feature above. The trade builder showed
just names; proposing or accepting committed immediately with no chance to actually evaluate
value. Confirmed with the user: full stats everywhere, a review step before propose/accept
actually commits, commissioner force-process stays one-click (no stats screen), and "Counter"
in the simplest possible form.

- **Full stats reused, not rebuilt** — `getPlayerStatsAggregate({ playerIds })`
  (`src/lib/players/rankings.ts`) already supported fetching stats for an arbitrary specific
  list of player IDs; no new stats-fetching code anywhere in this feature. New
  `src/app/leagues/[id]/trades/TradeAssetSummary.tsx` (`PlayerStatLine`/`TradeAssetSummary`,
  no directive — imported directly by both a Server Component and a Client Component) renders
  the same `SKATER_COLUMNS`/`GOALIE_COLUMNS`/`POINTS_COLUMNS` set as the Players/team pages, as
  an inline per-player stat strip rather than a full table, to keep the give/receive two-column
  layout readable.
- **Propose review is pure client-side staging** — `proposeTrade` commits immediately on call
  (creates a real `PROPOSED` row), so the review-before-sending step happens entirely in
  `TradeBuilder.tsx`'s own state (`step: "select" | "review"`, controlled checkboxes) *before*
  ever calling the Server Action. Backing out via "Back" never leaves a half-created trade.
  "Confirm & Send" is the one real `<form action={proposeTradeAction...}>`, with the selections
  carried across as hidden inputs — `proposeTradeAction`/`proposeTrade` themselves are
  unchanged.
- **Accept review is a real detail page**, not staging — a `PROPOSED` row already exists by
  this point. New route `/leagues/[id]/trades/[tradeId]/review`, backed by new
  `getTradeDetailById` (`src/lib/trades/mutations.ts`), which shares a new private
  `mapTradeToDetail` helper with `getTradesForLeague` rather than duplicating the mapping.
  `TradeItemDetail` gained `playerId`/`pickId` fields (previously only derived display strings
  `playerName`/`pickLabel`) so the review page and the counter-offer prefill can actually
  reference the underlying assets, not just their labels. Only the counterparty manager sees
  live Accept/Decline/Counter buttons; the "Needs your response" list's inline Accept/Decline
  buttons were replaced with a link here — review is now mandatory for propose/accept, which
  was the point. Commissioner force-process is untouched, still one-click, no stats screen.
- **Counter, kept intentionally simple**: `counterTradeAction` declines the original trade
  (reusing `respondToTrade`'s existing decline path verbatim) and redirects to
  `/trades?counterFrom=<tradeId>`. `page.tsx` re-validates server-side that the current team
  was genuinely the counterparty on that trade before trusting the query param, then builds
  swapped `initialGive`/`initialReceive`/`initialCounterparty` props for `TradeBuilder` — what
  the original proposer gave becomes what's now offered to receive, and vice versa, fully
  editable before submitting as a brand-new, unlinked trade. No "countered" relationship in the
  data model; no activity-feed changes needed (the feed only ever surfaced `PROCESSED`/`FORCED`
  trade events already, so a decline-then-repropose is invisible there until it actually
  completes, same as any ordinary trade).
- `respondToTradeAction` gained a `redirect()` back to `/trades` after Accept/Decline, so acting
  from the review page doesn't leave the manager sitting on a now-stale page.
- Verified in a new `scripts/trade-review-check.ts` against the real DB: `getTradeDetailById`
  returns the right shape including `playerId`; the counter flow (decline, then a fresh
  `proposeTrade` with swapped give/receive) produces a wholly separate `tradeId` with no
  linkage back to the original, which stays `DECLINED` and untouched;
  `getPlayerStatsAggregate` covers every participant player ID pulled from a trade's items.
  Every pre-existing regression script re-run clean afterward, including `trades-check.ts`
  itself. Checked live in a real browser as two different identities against the real "QTest"
  league: the builder showing full stats per player, Review Trade → Confirm & Send actually
  creating the `PROPOSED` trade, the counterparty's review page rendering both sides with
  stats, and clicking Counter correctly declining the original and landing back on the builder
  with the swapped assets pre-checked and still fully editable.

## Standings redesign: PCT/GB/streak/moves, sortable season stats, playoff odds

The old Standings page was Team/W/L/T/PF/PA in one plain table plus a Playoffs section. Redone
after a reference screenshot the user provided, scoped down in three places confirmed with
them directly: **PPP and SHP are dropped entirely** (this app's `GameStatLine` has no
power-play or shorthanded data at all — same reason those fields are already absent from the
league settings scoring form; showing them as fake zeros would be a hollow stat), **clinch
markers (x/y/z/e) and the glossary are left out** (real magic-number math against the
remaining schedule is a separate feature), and **Playoff % is a simple rank-based heuristic,
not a simulation**.

- **`src/lib/matchups/standings.ts`** gained four new exports, all read-only, no schema
  changes:
  - `StandingsRow` gained `logoUrl` and `streak` (e.g. `"W3"`) — the streak falls out of the
    same completed-periods loop `getStandings` already ran, no second query.
  - `getTeamSeasonStats(leagueId, season)` — per-team season-long raw stat totals (G/A/SOG/
    HIT/BLK, W/GA/SV/SO/OTL), using the **exact same "started players only" scope**
    `getTeamScoreForPeriod` already uses for the win/loss record (non-BE `LineupEntry` joined
    to `GameStatLine`) — confirmed with the user this must never include bench or farm-team
    production. Scoped to the whole season's date range (every `MatchupPeriod`'s span), not
    one period at a time. `OTL` is new — real data (`decision === "O"` in `statsJson`), just
    never aggregated anywhere before now.
  - `getTeamMoveCounts(leagueId, season)` — counts real roster transactions per team
    (add/drop, send-down/callup, IR moves, an *awarded* waiver claim, a FAAB win, a *processed
    or forced* trade) from `TransactionLog`, explicitly excluding lineup edits, commissioner
    overrides, raw FAAB bids, and any not-yet-resolved trade/waiver state.
  - `getAvailableSeasons` / `estimatePlayoffOdds` — the season selector's option list (always
    includes the league's current season even pre-schedule), and the playoff-odds heuristic
    itself: rank-based, linearly interpolated 95→55 inside the bracket cutoff and 45→5 outside
    it, `null` with no bracket configured or no games played yet (deliberately not shown as a
    number when it would carry no real signal).
- **Page rewrite** (`src/app/leagues/[id]/standings/page.tsx`): header gains a league-type
  badge, a season selector (new `SeasonSelect.tsx`), and — only when a playoff bracket is
  configured — a link to the new bracket page. Division tabs reuse the page's existing
  division-grouping, just as a tab strip instead of stacked sections. The standings table
  itself stays server-rendered (not sortable — only the Season Stats table needed that, per
  the user's own request) but gained PCT, GB (relative to the leader within whichever
  group/division is currently shown), and Playoff % (column omitted entirely with no bracket).
- **New `SeasonStatsTable.tsx`** — one row per team (a team aggregates both skaters and
  goalies, unlike the player-level tables), sortable by any column via the same
  `sortKey`/`sortDesc` click-header convention `PlayerStatsTable.tsx` already established.
- **New `/leagues/[id]/standings/bracket` route** — the "Projected Playoff Bracket" link, kept
  honest: seeds today's actual top-N teams (by real current standings) and pairs them via the
  existing `standardSeedOrder` (`src/lib/matchups/playoffs.ts`, reused verbatim — already
  exhaustively tested for real playoff seeding). Explicitly labeled "if the playoffs started
  today" and projects **only the first round** — it does not simulate winners through later
  rounds, since that would be fabricating outcomes rather than reading real current state.
- Verified in a new `scripts/standings-redesign-check.ts` against the real DB: season stats
  correctly exclude a bench-only stat line while counting started ones; move counts include
  exactly the intended transaction types/events and exclude the rest, scoped to the right date
  range; a manufactured loss-then-two-wins sequence produces streak `"W2"`; playoff-odds
  ordering is monotonic by rank and `null` with no bracket; a fresh league with no schedule
  still lists its current season. Every pre-existing regression script re-run clean afterward.
  Checked live in a real browser against a disposable 4-team scheduled test league: the
  redesigned header/badge/season-selector, the standings table's new columns with correct GB
  and playoff-odds values, the Season Stats table sorting correctly by several different
  columns (including a live sort-direction indicator), and the bracket page correctly pairing
  seeds 1v4 and 2v3 from real current standings.

## App-wide light redesign: design system, light-only theme, ESPN-style structure

The app previously followed the OS `prefers-color-scheme` for dark mode — since the user's
system defaults to dark, they were always seeing the dark navy variant, which read as "far too
dark" regardless of anything else. Fixed at the root rather than tuned: light is now the
*only* theme (the whole `@media (prefers-color-scheme: dark)` block in `globals.css` is gone),
matching ESPN Fantasy having no dark mode at all. Research (three parallel Explore passes over
every built page) also surfaced a real, independent problem worth fixing at the same time:
**three incompatible button systems** had grown across the app — a `rounded-full border` pill
(dominant), a `rounded bg-navy` solid CTA (oddly used for both top-level page actions *and* the
Commissioner Settings save button), and Players-page-only gold variants — with no shared
`Button` component anywhere.

- **`src/app/globals.css`** — new light palette (near-white background, white cards, near-black
  text, existing navy/gold accent identity kept rather than switching to ESPN's own blue —
  confirmed with the user as the preferred direction). Added semantic `--success`/`--warning`/
  `--danger` tokens (+ tints), replacing raw `emerald-500`/`amber-500`/`red-500` Tailwind
  utilities that were scattered ad hoc across banners and badges.
- **New `src/components/Button.tsx`** — `Button`/`LinkButton` (four variants: `primary` solid
  navy, `secondary` bordered, `danger` outlined red, `ghost` text-link; small rounded-rect
  corners matching ESPN's actual button shape, not a pill) and `Badge` (the pill shape moved
  here, reserved for non-interactive tags — YOU, AUTO, ORPHANED, IR, GP+ threshold, etc.). Every
  raw `<button>`/`<Link>`-as-button across the app (~50 call sites) now goes through this.
- **Global chrome** (`src/app/layout.tsx`, `src/components/NavBar.tsx`,
  `src/components/LeagueNav.tsx`) — root header switched from a filled navy bar to a white
  header with a bottom border; both nav bars switched from a filled-gold active pill to an
  ESPN-style underline-tab treatment (matches the tab convention already used on the team/
  standings pages). Commissioner Settings stays visually distinct (gold text) without needing
  to look like every other tab.
- **Commissioner Settings restructured, not just reskinned** — the single `<form>` wrapping six
  settings sections had its "Save settings" button buried at the very bottom in the one
  primary-CTA style used nowhere else on the page; it now sits in a visible header row at the
  *top* of that form group. Inconsistent section spacing (mixed `mt-4`/`mt-6`/`mt-10`) is now
  one rhythm. Destructive actions (delete league/team, cancel a draft, reset a schedule, start a
  new season) get the new `danger` variant — a real distinct visual tier for the first time,
  rather than red text on the same pill as every other button.
- **Players page** — the filter row used to mix position tabs + two `<select>`s + a count in
  one flex-wrap row; split into ESPN's actual layout, a full-width position-tab strip on its
  own line with filters on the row below.
- **Draft room** (`src/app/leagues/[id]/draft/DraftRoom.tsx`) — gained a persistent "Round X of
  Y · Pick Z overall" progress header, which didn't exist before. Required extending
  `DraftStateView` (`src/lib/draft/mutations.ts`) with `totalRounds`/`totalPicks`, computed from
  the draft's own `DraftPick` rows (max round / total count) — a small, additive, display-only
  change with no effect on draft logic itself; `scripts/draft-check.ts` re-run clean afterward.
- **Scoreboard** (`src/app/leagues/[id]/scoreboard/page.tsx`) — matchup cards flipped from
  vertically-stacked home-then-away rows to ESPN's actual horizontal side-by-side layout (team
  left, team right, flanking a centered score).
- **Honest scope note**: this applies ESPN's well-established, consistently-observed
  conventions (confirmed via live unauthenticated browsing of ESPN Fantasy Hockey's mock-draft
  lobby/waiting room, plus two real reference screenshots the user provided earlier for the team
  and standings pages) — there's no login to a real ESPN league, so authenticated screens
  (Settings/Draft/Scoreboard) are matched by convention, not pixel-copied coordinates.
- Verified with `npx tsc --noEmit` → `npm run build` after each phase, every pre-existing
  regression script re-run clean (this was a styling/structure pass with no other business-logic
  changes besides the additive `DraftStateView` fields). Checked live in a real browser via the
  `// TEMP:` bypass (reverted, `grep -rn "TEMP:" src/` clean): the redesigned header/nav, League
  home, Commissioner Settings (new Save-button placement, all sections), the team page's Move UI
  action bar and header card, the Players page's split filter row, and the Draft/Scoreboard/
  Trades pages' empty states — all rendering correctly on the new light theme with no console
  errors beyond one pre-existing, unrelated 404 (a missing static asset, not caused by this
  pass).

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. This is the first point where per-league scoring customization
  (DESIGN.md §2.4/§2.10) would actually show up if a league changed its config — and now a
  league can, via `/leagues/[id]/settings` (see above).

## Requested-changes batch: watchlist, roster UX, league rosters page, scoreboard, notifications

A list of ~15 ESPN-inspired requests came in together (see BACKLOG.md's two deferred items
for what got pulled out of this batch). Broken down item by item with the user before
building, then shipped in two commits, each verified against real data (a disposable test
league plus the full existing regression suite for the first commit; the second commit's
new read-only pages were checked directly against the user's own real "Experimenting"
league, which surfaced genuinely real trades in the new Notifications section — not just a
seeded fixture).

**Watchlist** (new `WatchlistEntry` model, `src/lib/players/watchlist.ts`) — per-league,
per-user. A ☆/★ toggle on every Players-page row plus a "My Watchlist" filter option, no
roster mechanics involved.

**Players page**: Add button restyled as a round gold "+" pill (ESPN-style) instead of a
text link; the IR badge (`Player.officialRosterStatus`, already shown on the team roster
page) now shows here too.

**Add-when-full fixed**: `addPlayerToRoster` gained an optional `dropPlayerId` — adding a
player when the active roster is already at cap no longer throws an unhandled error. Both
the Players page and the new team-page Add box expand an inline "who do you want to drop?"
picker and do the drop+add atomically in one transaction.

**Team roster page decluttered**: new "+ Add" / "− Drop" pills (`RosterMoveBoard.tsx`,
new `AddPlayerBox.tsx`) replace the always-visible inline Farm/Drop buttons — those only
appear now behind the "− Drop" toggle, and dropping requires a second confirm click
("Drop so-and-so? Confirm/Cancel") so a player can't be dropped in one accidental click.

**Trade cancel restricted**: `cancelTrade` no longer lets a manager or commissioner back
out of a trade once the counterparty has accepted (`UNDER_REVIEW`) — only the
commissioner's force-process resolves a stuck one now. `startNewSeason`'s internal
wipe-in-flight-trades path keeps working via a new `allowUnderReview` bypass, since that's
a legitimate system-driven cancellation, not a manager backing out. `scripts/trades-check.ts`
updated to assert the new behavior instead of the old one.

**League Rosters page** (new `/leagues/[id]/teams/rosters`, linked from the Other Teams
page) — every team's Active + Farm + IR roster side by side on one scrollable page.
Position shown is `primaryPosition`, not a live lineup slot (this is an overview page, not
a lineup tool); no "how acquired" column — no cheap pre-aggregated source for that per slot,
and adding one just for this page wasn't worth the extra query weight.

**Scoreboard redesigned** (`src/lib/matchups/standings.ts`'s new `getTeamTopScorersForPeriod`
+ `ScoreboardMatchup` gaining `homeTeamLogoUrl`/`awayTeamLogoUrl`/`homeTopScorers`/
`awayTopScorers`) — team logos, bigger score display, and a real "top scorers this matchup
so far" row per side. Deliberately **not** ESPN's "Projected Leaders" — this app has no
stat-projection data source (same reason projections are already absent everywhere else),
so this shows actual fantasy points scored within the period instead, confirmed with the
user as the honest substitute. No "Matchup"/"Box Score" detail-page buttons — no such
per-matchup detail page exists yet and building one wasn't asked for; flagged rather than
adding dead links.

**League home gained a "Scores" card** in the right-column sidebar (current week's matchups,
team logos, scores, "View Full Scoreboard" link) — reuses `getScoreboardForPeriod`, no new
query.

**Team page Notifications section** (new `src/lib/notifications/feed.ts`) — renders just
below the header identity card. Scoped to exactly what the user asked for: trades needing
your response or awaiting the other side, your own pending waiver claims, your team's most
recent resolved waiver/FAAB results (win **or** loss — unlike the league-wide activity feed,
which only ever shows terminal wins), and a roster-deadline case (an IR player who's
actually cleared but still sitting on your IR tier). Waiver/FAAB "recently resolved" scoping
uses `createdAt` (submission time, not resolution time) since neither model has a
resolved-at timestamp — close enough for a lightweight notification list, not worth a
migration for.

## Stat range dropdown: Last 7/30 Days (team-page batch, Task 1)

First of a four-task batch (`plans/team-page-batch.md`, five user-reported issues planned in
one pass so later sessions don't re-derive root causes). This task: the team page's stats
dropdown gains **Last 7 Days** / **Last 30 Days** alongside the existing season aggregates,
and the Players page — which previously had no range control at all, just a hardcoded
"2025-26 season stats" header — gets the same dropdown (minus "Daily", which is tied to the
team page's date strip and means nothing outside it).

- **`src/lib/players/seasons.ts` generalized from `SEASONS`/`seasonByValue` to
  `STAT_RANGES`/`resolveStatRange`** — a `StatRangeOption` is either `kind: "season"` (the
  existing two hardcoded windows, same `value`s `"2025"`/`"2026"` so old bookmarked URLs keep
  working) or `kind: "rolling"` (`days: 7 | 30`). `resolveStatRange(value, today?)` resolves
  either kind to a concrete `{ start, end, label }` — a rolling window is `days` calendar days
  **including today** (`shiftDate(today, -(days-1))` through end-of-`today`), computed fresh
  on every call rather than stored. `today` is injectable (defaults to real `todayUTC()`) so
  `scripts/stat-range-check.ts` can anchor a rolling window on a date that actually has
  ingested data instead of the real calendar date. Both old exports are gone — only two
  callers existed (`ViewControls.tsx`, the team page), both migrated, confirmed by grep before
  deleting.
- **Team page** (`teams/[teamId]/page.tsx`) — `resolvedRange` is computed once and reused for
  both the `getPlayerStatsAggregate` call and the non-daily label span (previously hardcoded
  "Season aggregate — Today"/date; now shows the resolved range's own label, e.g. "Last 7
  Days" or "2025-26"). Falls back to `resolveStatRange("2025")` for an unrecognized `view`
  value, same fallback behavior the old `seasonByValue` chain had.
- **Players page** — new `?range=` search param (validated against `STAT_RANGES`, default
  `"2025"`), passed as `dateRange` to **both** `getPlayerStatsAggregate` calls (the exhaustive
  name-search path and the default top-300 pool — previously neither passed a `dateRange` at
  all, so both silently returned career totals that only *looked* like 2025-26 because just
  one season is ingested). Header text is now dynamic (`{league.name}'s scoring, {label}.`)
  instead of a hardcoded "2025-26 season stats" string.
- **New `StatRangeSelect.tsx`** (client) — a "Stats" `<select>` rendered next to
  `PlayerSearchBox` on the Players page, navigating via `router.push` with the current search
  params merged so an in-flight `q` survives a range change. `PlayerSearchBox` gained a
  `range` prop and a `<input type="hidden" name="range">` inside its GET form, so submitting a
  name search doesn't silently reset the range back to default.
- **It's the offseason** (last ingested game: 2026-04-16) — Last 7/Last 30 correctly show all
  zeros on both pages until real games resume in October. Confirmed with the user ahead of
  time as expected, not a bug; `stat-range-check.ts` explicitly asserts the future-anchored
  case resolves and queries cleanly (zeros, no throw) rather than just eyeballing it.
- Verified in `scripts/stat-range-check.ts` (read-only, no test data — queries real recent
  `GameStatLine` rows) against the real DB: `resolveStatRange("last7"/"last30", "2026-04-16")`
  (the last real ingested date) both yield at least one player with non-zero
  `gamesIngested`, and `last7 gamesIngested <= last30 gamesIngested` holds for every player
  checked; `resolveStatRange("last7", "2026-09-16")` (today, offseason) resolves and queries
  cleanly with every row zeroed, no throw. Checked live in a real browser (via the `// TEMP:`
  bypass technique — this task also needed it in `searchPlayersAction`, a Server Action called
  from the Players page's typeahead that has its own independent `auth.protect()` call not
  covered by the page-level bypass; reverted along with the rest,
  `grep -rn "TEMP:" src/` clean) against the real "Experimenting" league, read-only: team page
  `?view=last7`/`?view=last30` both render the correct label and all-zero rows with no error;
  Players page `?range=last30` shows "Experimenting's scoring, Last 30 Days." and the correct
  dropdown selection; changing the dropdown (`2025-26`) navigates and updates both the header
  label and the result count/rows; submitting a name search ("McDavid") from a `range=last30`
  page correctly kept `range=last30` on the results page instead of resetting to the default
  season.

## Team header restructure + Notifications modal (team-page batch, Task 2)

Second of the four-task batch (`plans/team-page-batch.md`). Issues #1/#3: the header card's
two buttons (Propose Trade, `+ Add`) moved down into the action bar below Auto-Set, the
header's own `+ Add` is gone, and the always-visible Notifications list (which could push
the whole page down) became a "Notifications (N)" pill that opens a modal.

- **New `src/components/Modal.tsx`** — this app's first modal, built on the native
  `<dialog>` element specifically so Esc-to-close and focus containment come for free from
  the browser instead of being hand-rolled. Deliberately generic (`open`/`onClose`/`title`/
  `children`) — **the backlog's player-profile modal is expected to reuse this same
  component next**, not build its own.
  - **Real bug found and fixed while verifying**: the modal rendered pinned to the
    top-left corner instead of centered. Cause: a native `<dialog>` opened via
    `showModal()` centers itself using the UA stylesheet's `margin: auto`, but Tailwind's
    preflight resets `margin: 0` on every element, which wins the cascade and kills the
    centering. Fixed with an explicit `m-auto` utility class on the dialog, which — as a
    later utility class — overrides preflight's reset.
  - Backdrop click is a manual `onClick` check (`e.target === dialogRef.current`, since a
    click on the `::backdrop` area lands on the `<dialog>` element itself — there's no
    separate hit-testable backdrop node). Verified working via a real click in the browser.
  - Esc-to-close is native browser behavior (the default action of the `cancel` event a
    modal `<dialog>` fires on Escape), not app code — confirmed correct by calling
    `dialog.close()` directly (which is what that default action does) and watching the
    `onClose` prop tear the modal down correctly. **Caveat found while verifying**: the
    browser automation tool's synthetic Escape keypress reached the page as a trusted,
    non-prevented `keydown` (confirmed via a temporary console listener) but did not
    trigger Chromium's internal default action that closes a modal `<dialog>` — a known
    limitation of how CDP dispatches synthetic key events without full native
    virtual-key-code metadata, not an app bug. A real keyboard's Escape key is unaffected;
    this just means Esc-to-close couldn't be exercised end-to-end through the automated
    browser tool itself, only proven correct at the mechanism level.
- **New `src/app/leagues/[id]/teams/[teamId]/NotificationsButton.tsx`** (client) — the
  header's only remaining button for a manager, rendered even at zero (one code path).
  `NOTIFICATION_DOT` and the notification-list markup moved here verbatim from `page.tsx`;
  the old always-visible section under the header card is gone entirely.
- **`RosterMoveBoard.tsx`'s action bar** is now `[Propose Trade] [+ Add] [− Drop]` —
  Propose Trade (`primary`) and `+ Add` (`secondary`) are both `LinkButton`s now
  (`/leagues/[id]/trades` and `/leagues/[id]/players`), not client-state toggles. `− Drop`
  is unchanged. Removed with it: `addOpen` state, the `activeOccupants` derivation, the
  `activeCap` prop (page.tsx no longer needs to pass it down either), and
  **`AddPlayerBox.tsx` (deleted)** — confirmed by grep it had exactly one importer.
  `CommissionerAddPlayerBox.tsx` and the Players page's own `AddPlayerCell` are unrelated
  and untouched.
- **`RECENT_RESULT_LIMIT` (`src/lib/notifications/feed.ts`) raised 2 → 10** — now that
  notifications live in a scrollable modal instead of competing for page space, there's no
  reason to truncate resolved waiver/FAAB results so aggressively.
- Verified in a real browser (`// TEMP:` hardcoded-userId bypass — needed in **three**
  places for this task: the page itself, `src/app/leagues/[id]/layout.tsx` (has its own
  independent `auth.protect()` the page-level bypass doesn't cover), and
  `dropPlayerAction` in `actions.ts` to exercise a real drop; all reverted,
  `grep -rn "TEMP:" src/` clean) against a disposable 3-team league seeded by
  `scripts/header-modal-test-league.ts` (kept in the repo, `--cleanup` flag deletes it by
  exact name): the counterparty team showed "Notifications (1)" with a working "needs your
  response" modal entry whose "View →" correctly targeted the trade's review URL; a
  bystander team showed "Notifications (0)" and the modal's "Nothing needs your attention
  right now." empty state; `+ Add` landed on the Players page; `− Drop` entered drop mode,
  showed the two-step Confirm/Cancel, and a real Confirm click actually dropped the roster
  filler player end-to-end. Cleaned up by exact name afterward
  (`npx tsx scripts/header-modal-test-league.ts --cleanup`) — never touched the user's real
  "Experimenting" league.

## Free agency locked until the draft (team-page batch, Task 3)

Third of the four-task batch (`plans/team-page-batch.md`), issue #5: before this, a
brand-new league's free-agent pool was wide open from the moment teams existed — nothing
stopped instant-adding a full roster and never running the (now-built) startup draft at
all. Now unowned players stay locked until a league's startup draft actually completes,
and re-lock while any later draft is genuinely in progress.

- **`getFreeAgencyStatus(leagueId)` / `assertFreeAgencyOpen(leagueId)`**
  (`src/lib/draft/mutations.ts`) — closed, checked in order: (1) any `Draft` for the league
  is `IN_PROGRESS` → `DRAFT_IN_PROGRESS` (every such draft is passed through
  `resolveDraftState` first and re-checked, since the draft clock resolves on read — a
  timer that fully expired with nobody watching the room must not keep free agency locked
  forever just because the DB row still says `IN_PROGRESS`); (2) a `DYNASTY` league with no
  `STARTUP` draft `COMPLETE` for the league, any season → `NO_STARTUP_DRAFT`; (3) a
  `REDRAFT` league with no `STARTUP` draft `COMPLETE` for `league.currentSeason`
  specifically → `NO_STARTUP_DRAFT` (so `startNewSeason`'s roster wipe correctly re-locks
  free agency each season, not just once ever). Otherwise open.
- **Gated**: `addPlayerToRoster` (`src/lib/rosters/mutations.ts`), `submitFaBid`
  (`src/lib/faab/mutations.ts`), `submitWaiverClaim` (`src/lib/waivers/mutations.ts`) — all
  three call `assertFreeAgencyOpen` before anything else about the request (before the
  FAAB-routing check, before "is this player already rostered," before "is this player
  actually on waivers"), so the closed-league error always wins over a more specific one.
  **Not gated**: `commissionerAddPlayer` (explicit override tool), `recordPick` (drafting
  *is* the draft), trade proposals (draft picks are tradeable pre-draft by design), and
  every internal roster move (callup/IR/send-down — not an acquisition of an unowned
  player).
- **Circular-import fix, done first per the plan**: `getFreeAgencyStatus` needs
  `resolveDraftState` (`draft/mutations.ts`), and `rosters/mutations.ts` needs to call the
  gate — but `draft/mutations.ts` already imported `getLeagueOwnershipMap` from
  `rosters/mutations.ts`, which would've been a cycle. Moved `getLeagueOwnershipMap`
  (unchanged) into a new `src/lib/rosters/ownership.ts` — a pure read with no dependents of
  its own, same shape as the existing `src/lib/leagues/season.ts` cycle-avoidance fix — and
  repointed its two importers (`draft/mutations.ts`, `players/page.tsx`). Confirmed
  afterward that `draft/mutations.ts` imports nothing from `rosters/mutations.ts`,
  `faab/mutations.ts`, or `waivers/mutations.ts` (only `leagues/mutations`,
  `rosters/ownership`, `players/rankings`), so those three can safely import the gate back.
- **Players page banner** (`players/page.tsx`, server-computed): closed shows a `Card`
  above the table with reason-specific copy and a link — "paused while the draft is
  running" → the draft room; "opens once the draft is complete" → the draft room (a draft
  exists in `SETUP`); commissioner sees "set up the draft in League Settings" → Settings,
  everyone else sees "your commissioner hasn't set up the draft yet" (no draft at all).
  `PlayerStatsTable` gained a `freeAgencyOpen` prop (default `true`, so no other caller is
  silently gated) — when false, the ownership/Add column renders `—` instead of the Add pill
  or the FAAB bid form for any unowned player. Watchlist stars are untouched — pre-draft is
  exactly when a manager builds a watchlist for the draft to come. The team page's `+ Add`
  pill (Task 2) already just links to Players, so no change needed there.
- **Real regression found and fixed while verifying**: `deleteLeague`
  (`src/lib/leagues/mutations.ts`) didn't account for `WatchlistEntry` rows (they reference
  `League` with no cascade, `RESTRICT`) — the seventh instance of this exact FK-teardown bug
  shape in this project (after `Matchup`, `LeagueSettingsLog`, `FaBid`/`FaabBudget`,
  `WaiverClaim`, `LineupEntry`, `Draft`). Caught for real: deleting the stale "Roster Action
  Test League (delete me)" artifact as part of the one-off reset below hit the FK violation
  live. Fixed by adding `watchlistEntry.deleteMany` to the same teardown transaction, in the
  same position (early, alongside the other league-scoped-not-team-scoped deletes).
- Verified in `scripts/free-agency-gate-check.ts` (disposable league, cleaned up by exact
  name) against the real DB: closed/`NO_STARTUP_DRAFT` before any draft, with
  `addPlayerToRoster`/`submitFaBid`/`submitWaiverClaim` all throwing the closed-league
  error specifically (not some other error they'd otherwise hit first); still closed with a
  `STARTUP` draft only in `SETUP`; closed/`DRAFT_IN_PROGRESS` once started; open again the
  moment the draft's last pick lands; a second (`ROOKIE`) draft in `SETUP` doesn't re-close
  it; starting that second draft re-closes it (`DRAFT_IN_PROGRESS`) and re-blocks
  `addPlayerToRoster`; and the resolve-on-read case specifically — backdating a draft's pick
  deadline far into the past *without* calling `resolveDraftState` directly, then calling
  only `getFreeAgencyStatus`, correctly triggers the autopick-catch-up itself and reports
  open, with the draft actually landing `COMPLETE` and both remaining picks actually used
  (not just the status field going stale). Checked in a real browser too (`// TEMP:` bypass
  in `layout.tsx` and `players/page.tsx` — both needed, each has its own independent
  `auth.protect()`; reverted, `grep -rn "TEMP:" src/` clean): a disposable pre-draft league's
  Players page showed the commissioner-facing "set up the draft" banner with every player
  row showing `—` instead of an Add pill; after completing a real 2-team startup draft
  against it, reloading showed the banner gone, `+` pills back for everyone except the two
  actually-drafted players (who correctly showed their owning team's name instead).

### One-off reset: "Experimenting" cleared for its first real draft

Run once, on 2026-09-15, per the plan's confirmed-with-the-user instructions —
`scripts/reset-experimenting-for-draft.ts` (kept in the repo; matches by **exact name AND
id**, aborts otherwise, and is genuinely idempotent — a second run detects nothing left to
reset and skips writing anything, including the `TransactionLog` rows, rather than logging a
duplicate "reset happened" event every time it's invoked).

- `--dry-run` matched the plan's documented live state exactly before doing anything: 50
  open roster slots (Finn 17, Dev 14, Rebuild Squad 19), 3 trades `UNDER_REVIEW`, 0 pending
  waiver claims, 0 pending FA bids, 39 `LineupEntry` rows (Finn 7, Dev 8, Rebuild Squad 24).
- The real run cancelled all 3 trades (`cancelTrade` with `allowUnderReview: true`, same
  approach `startNewSeason` uses), cleared 0 pending waiver claims and 0 pending FA bids
  (none existed), deleted all 39 lineup rows, closed all 50 open roster slots
  (`effectiveTo = now`, history preserved), and wrote one `COMMISSIONER_RESET`
  `TransactionLog` row per team (3 total). `MatchupPeriod`s and teams themselves were left
  alone, per the plan.
- Deleting the stale "Roster Action Test League (delete me)" artifact (0 players) is where
  the `WatchlistEntry`/`deleteLeague` bug above was actually caught — fixed, then the delete
  succeeded cleanly.
- Read-only snapshot afterward confirmed: 0 open roster slots for Experimenting, 0 trades
  `PROPOSED`/`UNDER_REVIEW`, 0 `PENDING` waiver claims, 0 `LineupEntry` rows;
  "Roster Action Test League (delete me)" no longer exists; "Experimenting", "QTest League",
  "QTest 2" all still do; total leagues went from 4 to 3, exactly as expected.

## Persistent lineups + auto-fill (team-page batch, Task 4)

Last of the four-task batch (`plans/team-page-batch.md`), issue #4 — the largest task, biggest
blast radius, done last on purpose. Before this, `LineupEntry` only ever got a row when a
manager explicitly clicked Move/Auto-Set for that exact date — every date nobody had touched
yet started completely empty, so cycling to a new day (or September, before the season starts)
showed the whole roster on the bench even for a team a manager had carefully set. `autoSetLineup`
made this worse by explicitly benching everyone without an NHL game that day, which is every
player during the entire off-season.

- **Two invariants, enforced by one idempotent function** — `ensureLineupMaterialized(teamId,
  date)` (`src/lib/lineups/mutations.ts`):
  1. **Carry-forward.** If `date` has no explicit rows yet, copy the most recent earlier date's
     rows (filtered to players still on the ACTIVE roster) forward as `date`'s starting point.
     No prior date with rows means an empty starting point.
  2. **Auto-fill.** Every active player with no row in that starting point (an explicit `"BE"`
     row means "benched on purpose" and is left alone) is ranked by career fantasy points and
     assigned into whatever slot capacity is still open (position slots first, then UTIL),
     skipping only a player whose own game has already started. A player with *no* game at all
     is still a valid candidate — nobody without a game can be locked — which is what lets a
     lineup auto-fill correctly even during a stretch with zero NHL games (September). Players
     with no open eligible slot get no row at all, so they're re-evaluated fresh the next time
     a slot opens rather than being stuck.
  All reads (roster, existing/prior rows, the NHL schedule, the stats query) happen before any
  write, and the writes (`createMany({ skipDuplicates: true })`, safe under concurrent calls for
  the same team/date via the `(teamId, playerId, gameDate)` unique key) go in one transaction.
- **Where it runs**: before `getLineupForDate` on every team-page view (any date, past or
  future — a write-on-read, same pattern the draft room's clock already used);
  **before the capacity check** in `setLineupSlot`/`swapLineupSlots`/`autoSetLineup` specifically
  (materializing after the check would let inherited-but-unmaterialized occupants slip past
  capacity); after the transaction in every interactive acquisition path (`addPlayerToRoster`,
  `callUpToActive`, `activateFromIR`, `commissionerAddPlayer`, `commissionerMovePlayer` when the
  target is ACTIVE, `forceProcessTrade` for both teams); and by the daily cron
  (`src/app/api/cron/daily-ingest/route.ts`), for **every team in every league**, for
  **yesterday and today**, placed after the waiver/FAAB/trade-processing calls so anyone awarded
  overnight lands in an open slot before anyone checks their team that morning — this is the
  primary mechanism that gives scoring real rows; page views are the fallback for any team the
  cron missed. `recordPick` (draft) deliberately does **not** materialize per-pick (a 200-pick
  draft shouldn't do 200 schedule fetches — the first team-page view after the draft auto-fills
  the whole roster at once, ranked, which is a better default anyway), and the cron-driven
  FAAB/waiver/trade *award* paths themselves don't materialize individually — the cron's own
  bulk materialize step, placed right after those processing calls, covers them.
- **`clearLineupFrom(teamId, playerId, fromDate = todayUTC())`** — the other half: deletes every
  `LineupEntry` row for that player from `fromDate` forward. Called from `dropPlayerFromRoster`,
  `sendToFarm`, `placeOnIR` (folded into `placeOnIR` itself now, superseding
  `placeOnIrClearingLineup`'s old single-date-only delete — a player already materialized into a
  *future* date's lineup before landing on IR needs those rows gone too, not just the one date
  being viewed), `commissionerDropPlayer`, `commissionerMovePlayer` (leaving ACTIVE),
  `addPlayerToRoster`'s drop-to-make-room branch, `executeTradeTransfers` (every PLAYER item, for
  the sending team — runs regardless of caller, cron or `forceProcessTrade`, since it's fixing a
  real bug, not an interactive-only convenience), and `startNewSeason` (every row for the
  league's teams, mirroring `deleteLeague`'s own teardown).
- **This closes a real, quietly-live scoring bug**: `dropPlayerFromRoster`/`sendToFarm`/trades
  never deleted a departing player's `LineupEntry` rows before this — `getTeamScoreForPeriod`
  sums fantasy points for every non-BE row in range, so a player dropped at noon could still
  score for his old team that night, and a stale row could block a real teammate from taking
  that slot (the "Click-to-move" pass partially worked around the capacity-blocking half by
  filtering counts to active-roster players, but never touched the scoring half). `clearLineupFrom`
  fixes the root cause directly instead of filtering around it.
- **`autoSetLineup` change**: players without a game that date are no longer forced to `"BE"`.
  Two candidate tiers, each ranked by points: players with a game fill slots first (depleting
  capacity), then whatever's left over goes to players without one. This is what makes Auto-Set
  usable during a real no-games stretch instead of benching the entire roster, while still
  preferring an actual game when there's a genuine choice. The shared slot-assignment loop
  (position slots first, then UTIL absorbs the rest) was extracted into a pure
  `assignStarters(candidates, remainingCap, positionMode)` helper reused by both
  `ensureLineupMaterialized`'s auto-fill step and `autoSetLineup`'s two tiers, instead of two
  copies of the same logic drifting apart.
- Verified in `scripts/persistent-lineup-check.ts` against the real DB (disposable league, far-
  future 2031 dates so nothing is ever locked, cleaned up by exact name): all 7 scenarios from
  the plan — position-slots-before-UTIL overflow ordering, a third same-position player getting
  no row once every eligible slot is full, sticky explicit `BE` surviving carry-forward while an
  auto-filled vacancy gets picked up by the next-best eligible player, `clearLineupFrom`'s
  date-scoping (a date before `fromDate` untouched, everything from `fromDate` on gone) plus
  `dropPlayerFromRoster`'s real wiring on top of it, a materialize call correctly reaching back
  through two empty intermediate dates to the last date that actually had rows, `autoSetLineup`
  filling real slots on a date with zero NHL games instead of an all-bench result, and the
  capacity guard correctly rejecting a move into a slot that's full only through inheritance
  (no explicit rows yet on that date). Free agency is gated (Task 3) — the script runs a real
  1-round/2-team startup draft first (rather than the ungated `commissionerAddPlayer` override)
  specifically so `addPlayerToRoster`'s own materialize-on-acquire call site gets exercised for
  real; the forced draft pick is a goalie on purpose, since G-only eligibility can never
  interfere with any C/L/D/UTIL assertion.
- **Two pre-existing regression scripts needed real adaptation, not just a re-run** — both
  because their fixture setups pre-dated auto-fill-on-first-touch and became ambiguous once
  `setLineupSlot` started materializing before its own capacity check:
  `scripts/move-feature-check.ts` rostered three real Centers against a league with a single C
  lineup slot, then made bare `setLineupSlot` calls assuming an empty lineup — the very first
  call now auto-fills two of the three centers into C/UTIL before the script's own explicit
  placement runs, and whichever one auto-fill picked might not be the one the test wanted in C.
  Fixed by explicitly benching all three centers first (bench has no capacity limit, so this
  always succeeds) before making the intended explicit placements. The same script's TEST B
  specifically checked that a farmed player's `LineupEntry` row survived *stale* (proving
  capacity checks filtered it out) — Task 4's `sendToFarm` now calls `clearLineupFrom` directly,
  so the row is deleted outright instead of left stale, which is strictly the better fix for the
  same bug. Updated the assertion to check the row is actually gone, then re-proved the older
  "capacity ignores non-active rows" fix still holds by using the now-vacant slot for a different
  active player. `scripts/score-check.ts` needed no changes and passed as-is.
- Checked live in a real browser (`// TEMP:` bypass in `layout.tsx` and the team page — both
  needed, each has its own independent `auth.protect()`; reverted, `grep -rn "TEMP:" src/`
  clean) against a disposable seeded league on the real current date: a team rostered with
  exactly enough players to fill every position slot (2C/2LW/2RW/4D/2G, no overflow) showed
  every one of them auto-filled into their correct C/L/R/D/G group the moment the team page was
  first viewed — confirmed against the raw `LineupEntry` rows, not just the rendered page, since
  the owner-view Move UI conveys current slot via row grouping/divider lines rather than a text
  label per row. A 13th rostered player (a 3rd goalie, over the G:2 cap) correctly got no row at
  all. The next day's date showed the identical 12-row lineup, carried forward byte-for-byte.
  Adding a 14th player via `commissionerAddPlayer` and reloading the team page showed him
  auto-filled into the one open UTIL slot immediately — no manual lineup action needed.

## Trade integrity: locks, fit checks, supersede-on-accept (trades batch, Task 1)

First of a three-task batch (`plans/trades-batch.md`, six user-reported trade issues planned
in one pass). This task: issues #4 and #5's backend half. Before this, `respondToTrade`
(accept) checked nothing about rosters — not fit, not even whether the offered items were
still owned — and nothing stopped a player in an accepted (`UNDER_REVIEW`) trade from being
dropped, farmed, called up, IR'd, put in a second trade, or claimed off waivers while the
first trade was still pending. Fit was only ever evaluated at processing time, so a
non-fitting trade could sit `UNDER_REVIEW` forever with no one told why.

- **Rules (confirmed with the user, not re-litigated here — see the plan for the full list)**:
  a player who's a `PLAYER` item in any `UNDER_REVIEW` trade is *locked* — can't be dropped,
  farmed, called up, IR'd/activated, put in a new trade proposal, or claimed on waivers, but
  his **lineup slot can still be changed** (he keeps playing for his current owner until the
  trade actually processes, matching ESPN). Commissioner override functions
  (`commissionerDropPlayer`/`commissionerMovePlayer`/`commissionerAddPlayer`,
  `forceProcessTrade`) are **not** gated by any of this. A `FARM` player currently sitting in
  a waiver-claim window can't be traded at all (blocked at propose *and* accept time, rather
  than trying to reconcile a claim against a pending trade). **Fit is each side's own
  responsibility at its own decision point** — the proposer's roster is checked when *they*
  propose, the acceptor's when *they* accept — so a trade can still reach `UNDER_REVIEW` with
  the *proposer's* room having since evaporated (they added players after proposing, or
  something else changed their roster); that's what the stuck-trade notification (below)
  exists for. Processing behavior itself is unchanged — a trade that doesn't fit when its
  review window ends still just stays `UNDER_REVIEW` and retries daily.
- **New `src/lib/trades/locks.ts`** — a deliberate leaf module, importing only `@/lib/db`.
  The lock check has to run *inside* `rosters/mutations.ts` (drop/farm/callup/IR) and
  `waivers/mutations.ts` (`submitWaiverClaim`), but those two already get imported *from*
  `trades/mutations.ts` (`activeRosterCap`, `voidPendingClaimsForPlayer`) — putting the check
  in `trades/mutations.ts` itself would have created the same circular-import shape already
  hit and avoided once before, for the free-agency gate (team-page batch Task 3's
  `rosters/ownership.ts` split). `getTradeLockedPlayerIds(leagueId, playerIds?)` returns a
  `playerId -> tradeId` map for every player locked by an `UNDER_REVIEW` trade in the league;
  `assertPlayersNotTradeLocked(leagueId, playerIds, what)` throws a message naming the player
  and what he can't be (`"<Name> is locked in a pending trade and can't be <what> until it
  processes."`). **Every call site**: `proposeTrade` and `respondToTrade`'s accept path
  (`src/lib/trades/mutations.ts`); `dropPlayerFromRoster`, `sendToFarm`, `callUpToActive`,
  `placeOnIR`, `activateFromIR`, and `addPlayerToRoster`'s drop-to-make-room branch
  (`src/lib/rosters/mutations.ts`); `submitWaiverClaim` (`src/lib/waivers/mutations.ts`,
  belt-and-braces — a locked player can't newly reach waivers since `sendToFarm` is itself
  gated, but a claim could already be pending from before he got locked). Nine call sites
  across three files, all importing from the one leaf module, none importing back.
- **`computeTradeFit(leagueId, items)` replaces the old private `wouldFitAfterTrade`** — same
  net-effect-per-team-per-slot-type arithmetic (current count minus what's leaving of that
  type plus what's arriving, using each player's *current* slot type, not a proposal-time
  snapshot), but now returns `{ fits: boolean; overflow: { teamId, slotType, excess }[] }`
  instead of a bare boolean, so callers can say "drop N players" instead of a generic
  failure. `executeTradeTransfers` (the cron/force-process path) just checks `.fits`, same
  behavior as before. New `buildProposalItems` pulls the give/receive -> per-item
  fromTeamId/toTeamId construction out of `proposeTrade` into its own pure export, so the
  Task 3 builder's pre-flight fit-check action can reuse it without duplicating the mapping.
- **`proposeTrade`** now asserts (after ownership, before the existing FAAB-availability
  checks) that no player on either side is locked or on waivers, then runs `computeTradeFit`
  on the would-be items and throws if the **proposer** would overflow: `"This trade would
  leave you N over your <Active/Farm/IR> roster cap — drop N player(s) first or add more of
  yours to the offer."` (worst tier first if several).
- **`respondToTrade`'s accept path re-validates everything as if proposing fresh**: every
  `PLAYER`/`PICK` item still actually owned by the side that offered it (`"This trade is no
  longer valid — not every player/pick is still owned by the team that offered them."` if
  not), no player locked by *another* `UNDER_REVIEW` trade, no player on waivers, and every
  `FAAB` item's amount still available (`getAvailableBudget` already nets out this same
  trade's own pending commitment since it's still `PROPOSED` at this point — add it back
  before comparing, or the trade's own promised amount double-counts against itself). Then
  `computeTradeFit` again, this time for the **acceptor**: overflow throws `"You must drop N
  player(s) to accept this trade."` Only once all of that passes does the transaction flip
  the trade to `UNDER_REVIEW`.
- **Accepting supersedes other proposals** — in the same transaction as the accept, every
  other still-`PROPOSED` trade in the league touching any of the same players (either side)
  is set to `CANCELLED`, with a `TransactionLog` payload `{ event: "SUPERSEDED", byTradeId }`.
  Otherwise one of those could be accepted later and fail at processing because the player's
  already gone.
- **`getTradeableAssets`** — each player now carries `lockedInTradeId: string | null` and
  `onWaiversUntil: Date | null`, so the Task 2/3 builder can disable a row and show why
  instead of letting a manager select an asset `proposeTrade` would just reject.
- **Stuck-trade notification** (`src/lib/notifications/feed.ts`) — for an `UNDER_REVIEW`
  trade whose `reviewEndsAt` has already passed (the case `processDueTrades` leaves pending
  and retries daily), `getTeamNotifications` now calls `computeTradeFit` and tells each side
  the truth: the overflowing side gets `"Trade with X is waiting on you — drop N player(s) to
  complete it"` (`TRADE_ACTION`, linking to the team page with `?dropMode=1&pendingTrade=` —
  Task 3 makes that URL do something; harmless before then), the other side gets `"Trade with
  X is waiting on them to clear roster room"` (`TRADE_PENDING`). A trade still inside its
  review window keeps the existing plain "under review until …" message.
- **Two pre-existing scripts needed adaptation, not just a re-run**, both already anticipated
  by the plan:
  - `scripts/trades-check.ts` and `scripts/trade-review-check.ts` rostered players via
    `addPlayerToRoster`, which the team-page batch's free-agency gate (Task 3) now blocks on
    a league with no completed startup draft — neither script runs one. Switched every
    rostering call to `commissionerAddPlayer` (the ungated override tool), same fix the plan
    called out in advance.
  - `trades-check.ts`'s room-conflict/cancel-blocked/force-process section (`d1`/`h1`/`e1`)
    used to fill Team B to its active cap *then* propose-and-accept three trades into it,
    relying on the old lenient accept to reach `UNDER_REVIEW` while already full. With the
    new accept-time fit gate, Team B can no longer accept into an already-full roster —
    reordered to propose-and-accept all three while Team B still had room (accepting doesn't
    move any roster rows; several `PLAYER` trades can sit `UNDER_REVIEW` at once without
    changing anyone's actual roster count), *then* fill Team B to cap, *then* run the
    backdate/process/cancel/force steps against each already-`UNDER_REVIEW` trade — same end
    states as before, just reordered around the new gate. Its final FAAB section
    (`getAvailableBudget` accounting for a pending trade's FAAB commitment) also called
    `submitFaBid` twice afterward to prove over/under-budget bids throw/succeed —
    `submitFaBid` is *also* free-agency-gated (same team-page batch Task 3), so both calls
    would now fail on the gate instead of the budget check. Dropped rather than worked around
    with a throwaway draft just to open the gate: the two calls duplicated ground
    `scripts/faab-check.ts` already covers directly, and the assertion unique to this script
    (`getAvailableBudget` correctly netting out a pending *trade's* FAAB commitment, not a
    bid's) had already passed by that point.
  - `trade-review-check.ts`'s cleanup was a hand-rolled FK teardown list
    (`TradeVeto -> TradeItem -> Trade -> TransactionLog -> RosterSlot -> Team -> League`)
    written before the team-page batch's Task 4 (persistent lineups) shipped —
    `commissionerAddPlayer` now calls `ensureLineupMaterialized`, creating real `LineupEntry`
    rows this list never accounted for, so deleting `Team` hit a live FK violation. Switched
    to the real `deleteLeague` (`src/lib/leagues/mutations.ts`) instead of extending the
    hand-rolled list one more time — the same single source of truth for FK teardown order
    `trades-check.ts`/`trade-integrity-check.ts` already use, kept current every time a new
    feature adds a referencing table (this is the *seventh*-plus instance of this exact gap
    shape found across the project — see the trades/waivers/draft/etc. sections above — the
    first one caught in a *script's own* cleanup rather than `deleteLeague` itself).
- Verified in a new `scripts/trade-integrity-check.ts` against the real DB (disposable
  3-team league, small caps — Active 3/Farm 1/IR 2 — so overflow is trivial to hit, rostered
  via `commissionerAddPlayer`, cleaned up by exact name): a proposer overflow throws naming
  the right N; a valid 1-for-1 proposes cleanly, then dropping the (not-yet-locked, still
  `PROPOSED`) offered player as commissioner makes the accept throw "no longer valid"; a
  2-for-1 into a full acceptor throws "You must drop 1 player" and succeeds once the
  commissioner frees a slot; every lock-gated function (`proposeTrade`, `dropPlayerFromRoster`,
  `sendToFarm`, `placeOnIR`, `callUpToActive`) throws on a locked player while `setLineupSlot`
  and the commissioner overrides still succeed; accepting one trade correctly cancels a second
  `PROPOSED` trade on the same player with a `SUPERSEDED` log row; a `FARM` player on waivers
  blocks a new proposal; `computeTradeFit` on a hypothetical 3-for-0 into a roster at cap-1
  reports `excess: 2`/`fits: false`; and `getTeamNotifications` correctly splits a stuck
  (expired, still-overflowing) trade into "waiting on you — drop N" for the blocking side and
  "waiting on them" for the other. Also re-ran `trades-check.ts` and `trade-review-check.ts`
  clean after their adaptations above, `npx tsc --noEmit`, and `npm run build`. **No browser
  check for this task** — issues #4/#5's UI half (locked-player badges, the roster-fit
  modals, drop-mode banners) is Task 3; this pass is backend-only, and confirmed as such
  rather than implying a browser check happened.

## Known gaps, deliberately not built (ask before building)

- **Dropping a player whose game already started forfeits his points that day** —
  `clearLineupFrom` deletes from today forward, including a slot whose game is already in
  progress; ESPN would block that drop outright instead. Blocking it is a separate rules change,
  not built here (`plans/team-page-batch.md`'s Task 4).
- Draft, playoffs, FAAB/"the wire", and trades are all now built — playoffs are opt-in
  per schedule generation (see below); FAAB is per-league opt-in,
  default off (a league that hasn't turned it on still uses free instant add exactly as
  before); trades are always on (see below); draft is commissioner-triggered, both startup
  and rookie types (see above) — a league that never sets one up just keeps using free
  instant add, same as before this feature existed.
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
