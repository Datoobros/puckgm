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
  real exhaustive search for that exact name. No player photos — no headshot data source
  exists anywhere in this app. **Bug found while verifying**: the dropdown popped back open
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

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. This is the first point where per-league scoring customization
  (DESIGN.md §2.4/§2.10) would actually show up if a league changed its config — and now a
  league can, via `/leagues/[id]/settings` (see above).

## Known gaps, deliberately not built (ask before building)

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
