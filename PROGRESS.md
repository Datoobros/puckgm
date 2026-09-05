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

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. This is the first point where per-league scoring customization
  (DESIGN.md §2.4/§2.10) would actually show up if a league changed its config — and now a
  league can, via `/leagues/[id]/settings` (see above).

## Known gaps, deliberately not built (ask before building)

- No playoff bracket — matchups/standings are regular-season only for now (see above).
- No draft. FAAB/"the wire" and trades are both now built — FAAB is per-league opt-in,
  default off (a league that hasn't turned it on still uses free instant add exactly as
  before); trades are always on (see below).
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
