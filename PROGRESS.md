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

## Waiver priority reconciles on read (bug fix, 2026-09-16)

User noticed a team that joined "Experimenting" a week after the league was created showed
"not yet ranked" on the Teams page. Root cause: `League.waiverPriorityJson` was seeded once
on first read from whichever teams existed then, and nothing ever added a later joiner —
and every `rank()` caller (waiver awards, FAAB tie-breaks) treats "not in the list" as
lowest priority, so the new team would have lost every contested claim, silently.

`getOrInitWaiverPriority` (`src/lib/waivers/mutations.ts`) now reconciles against the real
team list on every read: teams missing from the stored order are **prepended** (newest
first — the user chose front over back, consistent with the original seed rule and the
new team having the weakest roster), deleted teams are dropped, and the row is only written
when something changed. Verified on the real league via script (before `[Rebuild Squad, Dev]`
→ after `[Finn, Rebuild Squad, Dev]`, stable on re-read) and in the browser on the Teams
page (`#1 / #2 / #3` rendered). No schema change; no test data created.

## Trade hardening: loophole audit (trades batch, Task 1b)

Second of the three-task trades batch (`plans/trades-batch.md`) — a read-through of the whole
trade module and everything it touches, written after Task 1 shipped, looking for ways a
manager could gain an edge or grief another. All nine gaps found were confirmed real against
commit `3fc0b77`, not hypothetical; three rules decisions were settled with the user up front
(kept below, not re-litigated). Backend only, same as Task 1 — **no browser check**, said
plainly rather than implying one happened.

- **Picks can no longer be double-spent, or traded once used** (gap #1). New
  `getTradeLockedPickIds`/`assertPicksNotTradeLocked` (`src/lib/trades/locks.ts`) mirror the
  player-lock pair exactly, scoped to `TradeItem`'s PICK items in an `UNDER_REVIEW` trade —
  wired into `proposeTrade` (both sides) and `respondToTrade`'s accept re-validation, same as
  the player lock. `getTradeableAssets` and `assertOwnsAssets` both now also require
  `usedOnPlayerId: null`, so a pick already spent in a draft is neither shown nor accepted.
  `assertItemsStillOwned` (accept-time re-validation) checks the same unused-ness, closing the
  gap where a pick could get drafted *between* propose and accept (proposing never locked it).
- **Hostage trades get a real exit** (gap #2). `processDueTrades` gained a second pass after
  its normal one: any `UNDER_REVIEW` trade whose `reviewEndsAt` is more than
  `STUCK_TRADE_GRACE_MS` (3 days, named constant) in the past and still doesn't fit is
  `CANCELLED` outright, with a `{ event: "AUTO_CANCELLED", reason: "ROSTER_ROOM",
  blockingTeamIds }` log. **Decision, not re-opened**: auto-cancel only — no manual withdraw
  for the non-blocking side; the user declined that option. The commissioner's force-process
  remains the only way to push a still-in-window trade through early.
- **FAAB freeze by proposal fixed** (gap #3). `getAvailableBudget`
  (`src/lib/faab/mutations.ts`) used to subtract *any* team's FAAB commitment in a still-
  `PROPOSED` trade, including one they never agreed to — anyone could propose "I want $100 of
  your FAAB" and freeze a rival's bidding on sight. Now a `PROPOSED` trade only counts against
  the team that *proposed* it; `UNDER_REVIEW` still counts against either side, since both have
  actually agreed by then. `assertFaabStillAvailable`'s accept-time re-check
  (`src/lib/trades/mutations.ts`) needed a matching fix — it used to unconditionally "add back"
  this trade's own commitment before comparing, which only holds when the sender *is* the
  proposer; adding it back for the counterparty side (asked to give up FAAB to accept) would
  have double-counted in the wrong direction and silently under-enforced the real check. Caught
  by reasoning through the two FAAB-item directions before writing the verification script, not
  by a failing assertion.
- **Silent half-trades now fail loudly** (gap #4). `executeTradeTransfers` re-validates every
  item (player still owned, pick still owned *and* unused, FAAB still available) before any
  write; on a failure it `CANCELLED`s the whole trade with a
  `{ event: "INVALIDATED", reason: "<sentence naming the item>" }` log instead of silently
  skipping the stale item and marking the trade `PROCESSED` anyway. The old
  `if (!oldSlot) continue;` is now `if (!oldSlot) throw` — unreachable in practice once both
  locks exist, kept as defense in depth, not a silent no-op. New `TradeExecutionOutcome`
  member: `"INVALIDATED"`.
- **Trade deadline re-checked at accept, not just propose** (gap #5). A proposal made before
  the deadline could previously be accepted after it; `respondToTrade`'s accept path now
  re-checks `tradeDeadline` the same way `proposeTrade` does.
- **Trades frozen during a live draft** (gap #6). New `assertNoDraftInProgress(leagueId)`
  (`src/lib/draft/mutations.ts`, resolve-on-read first, same principle as
  `getFreeAgencyStatus`) blocks both `proposeTrade` and `respondToTrade`'s accept path while
  any draft in the league is genuinely `IN_PROGRESS`. **Decision, not re-opened**: full freeze
  — no proposals *and* no acceptances of any kind, players or picks, confirmed with the user
  (not just a lock on drafted picks).
- **Three more accept-time gaps closed** (gap #7): `respondToTrade`'s accept path now
  re-checks both teams for `ORPHAN_FROZEN`, re-checks `draftPickTradingEnabled` when the trade
  has pick items, and — the same-instant double-accept race (two co-managers, or the same
  request twice) — the final write is now an **interactive transaction**:
  `tx.trade.updateMany({ where: { id, state: "PROPOSED" }, data })`, throwing "This trade was
  already answered." if `count !== 1`. Closes the race with no new schema — Postgres's own
  row-level locking on the conditional `UPDATE` guarantees only one concurrent caller can ever
  flip the row. Verified with two genuinely concurrent `respondToTrade` calls
  (`Promise.allSettled`) against a real Neon connection: exactly one fulfilled, the other
  rejected, exactly one `ACCEPTED` log row.
- **FAAB items blocked in FAAB-off leagues** (gap #8). `proposeTrade` throws if either side
  offers a nonzero FAAB amount and `!settings.faabEnabled`; `getTradeableAssets` reports
  `availableFaab: 0` for such a league instead of a real-looking number with nothing backing
  it.
- **Orphaning a team now cancels its in-flight trades first** (gap #9). The fix lives in the
  Server Action layer (`orphanTeamAction`, `src/app/leagues/actions.ts`), not
  `leagues/mutations.ts` — `trades/mutations.ts` already imports from `leagues/mutations.ts`,
  so importing `cancelTrade` back in there would reopen the exact circular-import shape already
  avoided elsewhere in this app. Same approach `leagues/season.ts`'s `startNewSeason` already
  uses for its full-roster wipe: find every `PROPOSED`/`UNDER_REVIEW` trade the team is party
  to (via `TradeItem.fromTeamId`/`toTeamId`), `cancelTrade({ allowUnderReview: true })` each,
  then orphan. Also added a direct commissioner check ahead of that cancellation loop — without
  it, a non-commissioner caller would have surfaced `cancelTrade`'s unrelated "you aren't part
  of this trade" instead of the usual "only the commissioner" error whenever the team happened
  to have a trade in flight.
- Not loopholes, verified during the audit and left alone: one-user-one-team is enforced on
  every join/claim/reassign path; FAAB double-commit across bids and trades was already handled
  (Task 1); the fit arithmetic is correct; veto threshold logic holds.
- Verified in a new `scripts/trade-hardening-check.ts` against the real DB (disposable 3-team
  league, small caps — Active 3/Farm 1/IR 1 — rostered via `commissionerAddPlayer`, cleaned up
  by exact name): all 9 numbered gaps above, plus a real 3-team/1-round `STARTUP` draft run to
  completion inline to prove the freeze lifts once the draft finishes. Re-ran
  `trade-integrity-check.ts` and `trade-review-check.ts` clean with no changes needed.
  `trades-check.ts` needed one adaptation (documented in a code comment there): its "full
  trade: player + pick + FAAB" section trades FAAB while `faabEnabled` was still `false` at
  that point in the script (gap #8 didn't exist when it was written) — flipped `faabEnabled:
  true` one step earlier, in the same settings update that already runs right before that
  section, rather than adding a new one. `npx tsc --noEmit` and `npm run build` both clean.
  **No browser check for this task** — Task 1b is backend-only, per the plan.

## Trades page split, ESPN-style builder, confirm modal (trades batch, Task 2)

Third of the trades batch (`plans/trades-batch.md`, issues #1/#2/#3). Before this, `/trades`
did everything at once — a builder card at the top (two-column checklist, no stats, a
full-page "review" step), then Needs-your-response/Waiting/Pending/**History** lists. This
task splits it into a short list page and a dedicated ESPN-style builder, and fixes the
"stays on the page after sending" spam-send bug by actually redirecting somewhere useful.

- **Two routes now.** `/leagues/[id]/trades` (`page.tsx`, rewritten) is just the three live
  lists — Needs your response / Waiting on a response / Pending (under review) — plus a
  `Propose Trade` button. **History is gone entirely** (issue #2), not hidden behind a
  toggle. `/leagues/[id]/trades/new` (new, `new/page.tsx`) is the builder — its own
  `auth.protect()`, redirects to the list page if the viewer has no team in the league or if
  the league has no other teams to trade with.
- **Builder layout matches the ESPN reference exactly**: counterparty picker → the *other*
  team's full roster (new `TradeRosterTable.tsx` — two stat tables, Skaters and Goalies, same
  `SKATER_COLUMNS`/`GOALIE_COLUMNS` + `POINTS_COLUMNS` the team/Players pages already use, one
  checkbox per row) → a `↓ Select who to offer below` button that
  `scrollIntoView({behavior:"smooth"})`s to a ref on the "Your roster" section → your own
  roster in the same table → a `sticky bottom-0` bar (`-mx-6` to cancel the page's own
  horizontal padding so it spans full width) showing `Receiving — <their team>` /
  `Offering — <your team>` as headshot+last-name chips, `Cancel Trade` (clears both
  selections), and `Continue` (disabled until at least one asset is selected on either side).
  `TradeRosterTable` also renders each team's draft picks and FAAB input below its stat
  tables — unchanged mechanism, just relocated. A row whose player is
  `lockedInTradeId`/`onWaiversUntil` (Task 1's fields on `getTradeableAssets`) has its
  checkbox disabled and a `Pending trade`/`On waivers` badge with the specific reason in the
  `title` — verified live against a real `UNDER_REVIEW` trade (see Verified below), not just
  by reading the code.
- **Confirm Trade modal reuses `Modal`** (`src/components/Modal.tsx`, from the team-page
  batch) rather than a full-page review step — `Continue` opens it with two lists (Receiving
  from X with → arrows, Offering to X with ← arrows: headshot, name, `NHL · pos`; picks and
  FAAB as plain text lines), a `Back` button, and `Send Trade Proposal`. Task 3's roster-fit
  pre-flight check is explicitly **not** in this modal yet — `Continue` always opens it
  directly, per the plan's scope for this task.
- **`proposeTradeAction`'s signature and return shape both changed.** It used to take
  `(leagueId, proposingTeamId, formData)` and be bound into a `<form action>`, relying on
  `revalidatePath` to refresh the still-mounted page (the "stays on the page" bug — nothing
  ever navigated anywhere, so a manager could resubmit). It's now called **imperatively** from
  `TradeBuilder.tsx` (`await proposeTradeAction(leagueId, myTeamId, counterpartyId, give,
  receive)`, plain objects, no `FormData`) and returns
  `{ ok: true; redirectTo: string } | { ok: false; error: string }` instead of throwing. This
  isn't just style — a Server Action invoked directly from a client event handler (rather than
  a `<form action>` submission) has a thrown error's message **redacted to a generic digest in
  production**, which would have swallowed `proposeTrade`'s specific validation text (locked
  player, roster overflow, deadline passed, draft in progress, …) that the confirm modal needs
  to show verbatim. Catching inside the action and returning a plain value sidesteps that
  entirely. `redirect()` itself is *not* called from the action either — `next/navigation`'s
  own docs are explicit that `redirect()` can't be used from a client event handler, only
  during render or a `<form action>` submission — so the client does `router.push(redirectTo)`
  once it sees `ok: true`.
- **The redirect** lands on `/leagues/[id]/teams/[proposingTeamId]?sent=<counterpartyTeamId>`.
  The team page (`teams/[teamId]/page.tsx`) reads `?sent=`, and — only when the viewer
  actually manages *this* team — looks up the named team (ignoring an unknown/stale id
  silently) and renders a one-time `Card` banner: "Trade proposal sent to \<team\>." It
  disappears on the next navigation since nothing persists it; no new state.
- **A non-owner who manages a different team in the league** now gets a `Propose Trade`
  shortcut in the team page's header (the same slot an owner sees `NotificationsButton` in),
  linking straight to `/trades/new?with=<thisTeamId>` — one extra lookup
  (`prisma.team.findFirst` with the existing `managerOrCoManagerWhere(userId)`), gated so it
  never shows for the team's own owner or for a plain non-manager visitor.
- **The give/receive/givePicks/receivePicks/giveFaab/receiveFaab URL-param restore is
  implemented now**, even though nothing generates those params yet — `new/page.tsx` parses
  them, validates every id against that pair's actual `getTradeableAssets` result (drop
  unknown ids silently, clamp FAAB to `availableFaab`), and passes the result as
  `initialGive`/`initialReceive`. This is what Task 3's "Return to trade builder" link (after
  a detour to drop-mode) will populate; building the one restore path now means Task 3 only
  has to generate the query string, not add a second parsing branch. The `counterFrom`
  prefill logic (only trusted when the viewer's team was genuinely that trade's counterparty)
  moved here **verbatim** from the old `/trades` page and takes priority over the
  give/receive params when both are somehow present.
- **Deleted**: `TradeBuilder.tsx`'s old `step: "select" | "review"` state machine and the
  `AssetChecklist` component (replaced by `TradeRosterTable.tsx` + the sticky bar + the
  modal); the builder `Card` and the entire History section from `/trades/page.tsx`.
  `TradeAssetSummary.tsx` (`PlayerStatLine`/`TradeAssetSummary`) is untouched — the accept
  review page (`[tradeId]/review/page.tsx`) still uses it, out of scope for this task.
  `RosterMoveBoard.tsx`'s `Propose Trade` button and `counterTradeAction`'s redirect both
  retargeted from `/trades` to `/trades/new` (with `counterFrom` carried on the latter).
- Verified in a real browser against a disposable 3-team league
  (`scripts/builder-test-league.ts`, kept in the repo with a `--cleanup` flag; rostered
  entirely from **real** `Player` rows already in the DB — Crosby, Malkin, Ovechkin, Kane,
  Doughty, Hellebuyck, Tavares, Marchand, Giroux, Letang, Bobrovsky — no synthetic fixtures
  needed for this task) using the `// TEMP:` hardcoded-userId technique in five places (the
  league layout, both trade pages, the review page, and every action in `actions.ts`, via one
  shared `TEMP_USER_ID` constant so switching identity was a one-line edit), all reverted
  before commit (`grep -rn "TEMP:" src/` clean): `/trades` showed the three lists with no
  History for both managers; `Propose Trade` landed on `/trades/new`; the counterparty's full
  roster rendered first with real stat columns; the scroll button moved the page to "Your
  roster"; a real `UNDER_REVIEW` trade (proposed and accepted between the other two teams as
  part of the seed) showed Kris Letang's row disabled with the `Pending trade` badge and the
  correct `title`; selecting a player on each side populated the sticky bar's chips; `Cancel
  Trade` cleared both back to "Nothing selected"; `Continue` opened the Confirm Trade modal
  with the right Receiving/Offering content and arrows; `Send Trade Proposal` landed on the
  proposer's team page with the "Trade proposal sent to Charlie." banner and the correct
  `?sent=` id in the URL; `/trades` then listed it under Waiting on a response for the
  proposer and Needs your response for the counterparty; clicking `Counter` from the review
  page declined the original (confirmed `DECLINED` in the DB) and landed on
  `/trades/new?counterFrom=<id>` with the counterparty and both selections correctly swapped.
  `npx tsc --noEmit` and `npm run build` both clean before and after reverting the `// TEMP:`
  bypasses. Cleaned up by exact league name afterward — never touched the real
  "Experimenting" league.
- **Not covered by this task, flagged for Task 3**: the roster-fit pre-flight check on
  `Continue` (a full-roster proposer currently just gets the ordinary server-side error from
  `proposeTrade` inside the modal, not the dedicated "Roster too full" variant with `Go drop
  players →`), drop-mode URL params (`dropMode`/`returnTo`/`pendingTrade`) on the team page,
  and the accept-side "you must drop N" flow on the review page. All are exactly what Task 3
  is scoped to build; this task's give/receive param-restore path is what it builds on top of.

## Roster-fit UX and locked-player UI (trades batch, Task 3) — batch complete

Last of the three-task trades batch (`plans/trades-batch.md`), finishing issues #4/#5's UI
half — Task 1 built the server-side locks/fit checks, Task 1b hardened nine loopholes, Task 2
built the ESPN-style builder; this task is the part the user actually sees when a trade would
overflow a roster, and marks the players a pending trade already has locked.

- **`Continue` on the builder now runs a pre-flight fit check first**, instead of always
  opening the confirm modal. New `checkTradeFitAction` (`src/app/leagues/[id]/trades/actions.ts`)
  is a pure read — `buildProposalItems` + `computeTradeFit` (both already exported from Task 1)
  — called imperatively from `TradeBuilder.tsx` so the pre-flight check can never drift from
  `proposeTrade`'s real server-side guard; the guard itself is unchanged, this is UX layered on
  top of it. If the **proposer** would overflow, a **Roster too full** modal opens instead of
  the confirm modal: "This trade would leave you N over your `<Active/Farm/IR>` roster cap.
  Drop N player(s) first, or add more of your players to the offer." with `Adjust trade`
  (closes it) and `Go drop players →`. That link encodes the *entire current selection* (give/
  receive/picks/FAAB, plus the chosen counterparty) into the same `give`/`receive`/`givePicks`/
  `receivePicks`/`giveFaab`/`receiveFaab`/`with` params `/trades/new` has parsed since Task 2,
  then navigates to `/leagues/[id]/teams/[myTeamId]?dropMode=1&returnTo=<that URL, encoded>`.
  If the proposer fits but the **counterparty** would overflow, the confirm modal opens as
  before with one added muted line: "`<Team>` will need to drop N player(s) to accept." —
  informational only, doesn't block sending.
- **Drop mode is now URL-driven**, not just a manual toggle. `RosterMoveBoard` gained an
  `initialDropMode?: boolean` prop that seeds its existing `dropMode` state; the team page reads
  `?dropMode=1` and passes it through. `?returnTo=` is only honored when it starts with
  `/leagues/<leagueId>/trades/new` (no open redirect) and renders a banner: "You're making room
  for a trade. **Return to trade builder →**" — clicking it lands back on the builder with the
  counterparty and full selection restored via Task 2's already-built param-parsing path; this
  task only had to generate the query string; the restore side shipped with Task 2 for exactly
  this reason.
- **The accept side gets the same pre-flight treatment.** The review page now computes
  `computeTradeFit` server-side (reusing the trade's own `items`, no new query shape needed) and
  hands the acceptor's overflow excess into a new client `AcceptTradeControls.tsx` (Accept /
  Decline / Counter, replacing the old inline buttons). Decline and Counter are **untouched** —
  still plain `<form action={respondToTradeAction/counterTradeAction}>` submits. Accept is the
  only one that changed: the submit button's `onClick` calls `e.preventDefault()` and opens a
  "Roster too full" modal ("You must drop N player(s) in order for this trade to go through." +
  `Go to my team →`) **only when there's overflow**; with no overflow the click falls through and
  the form submits exactly as it always did. This was deliberate, not a stylistic choice — both
  `respondToTradeAction`/`counterTradeAction` end in `redirect()`, and `next/navigation`'s own
  docs say `redirect()` can't be called from a client event handler, only during render or a
  real `<form action>` submission (the same reasoning already documented for
  `proposeTradeAction` in Task 2's section above). Calling them imperatively from a click handler
  the way `proposeTradeAction` is called would have broken the redirect silently.
  `Go to my team →` lands on `/leagues/[id]/teams/[myTeamId]?dropMode=1&pendingTrade=<tradeId>`.
- **The countdown banner.** `pendingTrade` on the team page loads that trade (`getTradeDetailById`,
  requiring it still be `PROPOSED` and this team actually a party — an unknown, non-party, or
  no-longer-pending id is ignored silently, not erroring) and runs `computeTradeFit` against its
  *current* items on every page load, so the banner is always live, not a snapshot from when the
  modal first opened: "Drop **N** more player(s) to accept the trade with `<team>`" while N > 0,
  flipping to "Roster has room — **Back to trade →**" (linking to the review page) once it hits
  zero. Verified live in the browser that this actually recomputes and decrements after each
  individual drop, not just on a hard reload.
- **Locked players are now visibly marked everywhere a manager could otherwise act on them.**
  `getTradeLockedPlayerIds(leagueId, playerIds)` (Task 1's `src/lib/trades/locks.ts`) is queried
  once per team-page render, scoped to the **whole roster** (Active + Farm + IR — the plan's own
  wording only mentioned "activePlayerIds" but Farm's Call Up and the IR list's activation both
  needed the same data, so it's fetched for every tier a locked player could be sitting in) and
  threaded through as a `Map<playerId, tradeId>`:
  - **Active roster rows** (`RosterMoveBoard`'s Skaters/Goalies tables): a `Pending trade` badge
    (`tone="navy"`, new addition to `MoveBoardBadge`'s tone union), `canDrop: false`, and
    `canSendToFarm: false` — so in drop mode the row shows no Drop button at all, and outside
    drop mode no `→ Farm` button. **Lineup `Move` deliberately stays enabled** — a trade-locked
    player still plays for his current owner until the trade actually processes (Task 1's own
    rule), verified live by actually opening Move on a locked player and confirming real
    destination options appeared.
  - **IR placement** — the healthy-active-player-to-IR option that gets appended onto an
    already-eligible player's move list is now skipped entirely for a locked player (would just
    hit `placeOnIR`'s existing lock guard from Task 1 anyway).
  - **Farm list**: `↑ Call Up` gains `tradeLocked` to its existing disabled/title logic
    (`"Locked in a pending trade"`, ahead of the active-full/callup-limit reasons), plus the same
    `Pending trade` badge next to the player's name.
  - **IR list**: `tradeLocked` is now a `disabledReason` cause (ahead of active-full/game-locked,
    behind "still officially on IR" since that's the more fundamental block), and a new
    `tradeLocked` field on `MoveBoardIrOccupantRow` drives the same badge in `RosterMoveBoard`'s
    IR list rendering.
  - The builder (`TradeRosterTable.tsx`) already disabled locked rows with a badge as of Task 2 —
    nothing more needed there.
- Verified end-to-end in a disposable 3-team league (`scripts/fit-ux-test-league.ts`, small
  6-slot active cap so a 2-player overflow is trivial to hit, rostered from real `Player` rows —
  copied and adapted from Task 2's `builder-test-league.ts` rather than reused as-is, per the
  shared-database convention, so each script's `--cleanup` only ever touches its own league) in a
  real browser using the `// TEMP:` hardcoded-userId technique (five places: the league layout,
  all three trade pages, and both actions files — reverted before commit,
  `grep -rn "TEMP:" src/` clean): as the proposer, building a 2-for-0 into a full 6/6 roster and
  clicking `Continue` produced the Roster-too-full modal with the exact text and N=2; `Go drop
  players →` opened the team page in drop mode with the return banner; dropping two players
  brought the roster to 4/6; `Return to trade builder →` restored the counterparty and both
  selections exactly; `Continue` now opened the real Confirm Trade modal (the fit modal was
  present-but-closed in the DOM the whole time — native `<dialog>` doesn't unmount, confirmed by
  checking both dialogs' `.open` property directly rather than trusting which one a screenshot
  happened to show); `Send Trade Proposal` landed on the team page with the "sent to" banner. As
  the acceptor on a **second**, pre-seeded trade (Bravo gives 2 players to an already-full
  Charlie): `Accept` on the review page produced "You must drop 2 player(s) in order for this
  trade to go through."; `Go to my team →` opened drop mode with "Drop 2 more player(s) to
  accept the trade with Bravo"; dropping one player live-decremented the banner to "Drop 1 more
  player(s)"; dropping the second flipped it to "Roster has room — Back to trade →"; that link
  returned to the review page; `Accept` there succeeded for real, confirmed `UNDER_REVIEW` in the
  database. Then, back on the proposer's (Bravo's) team page: both traded players (Doughty,
  Hellebuyck) showed the `Pending trade` badge (confirmed `bg-navy/10 text-navy`, not just
  visually similar to the existing `80+ GP` warning badge), had no `→ Farm` button and no `− Drop`
  button in drop mode, while `Move` was present and actually opened real destination options when
  clicked. `npx tsc --noEmit` and `npm run build` both clean before driving the browser and again
  after reverting every `// TEMP:` bypass. Cleaned up by exact league name afterward — never
  touched the real "Experimenting" league.
- **One real bug found and fixed while driving this through the browser, not by inspection**: the
  review page's `respondToTradeAction`/`counterTradeAction` `redirect()` to `/leagues/[id]/trades`
  hit that route's own independent `auth.protect()` — a page this task's own `// TEMP:` sweep had
  initially missed, since accepting from the review page had never been exercised against it in
  this session before. Caught immediately (redirected to Clerk's real sign-in instead of the
  bypassed page) and fixed by adding the same bypass there; confirmed the underlying accept had
  already committed to the database before the redirect misfired, so nothing about the actual
  fix (Task 3's product code) was at fault — purely a gap in which files the verification sweep
  had touched.

## Scoreboard redesign (scoreboard-batch, Task 1)

First of a two-task batch (`plans/scoreboard-batch.md`) to match the Scoreboard to ESPN's
actual layout. Task 2 (the Matchup detail page the new "Matchup" button links to) was a
separate session — the button pointed at its real route, `/leagues/[id]/matchups/[matchupId]`,
which 404d until that session shipped it (accepted in the plan; see the section below —
shipped same-day).

- **Layout** (`src/app/leagues/[id]/scoreboard/page.tsx`): header row gained a
  `Badge tone="muted"` ("DYNASTY LEAGUE"/"REDRAFT LEAGUE", from `settings.leagueType`) next to
  the title, and a `LinkButton variant="ghost"` "Projected Playoff Bracket" linking to the
  already-existing `/leagues/[id]/standings/bracket`. The controls row replaced the old
  Prev/Next buttons + "Week N of M · dates · Final" line with a "Matchups" label, a new
  `MatchupWeekSelect` client component (every period in the season, not just adjacent ones —
  jump straight to any week), and a `Final`/`In progress` `Badge` (muted/success) for the
  selected week; the existing `TeamScheduleSelect` stays, now right-aligned. Matchup cards went
  from a small centered-score 2-column grid to full-width, stacked, 3-column ESPN-style cards
  (`md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]`, divider borders, stacks to one column on
  mobile): a teams column (logo/name/seed, bold score, trailing team's name goes `text-muted`
  only once the week is `final`), a Top Scorers column, and a "Matchup" `LinkButton` column.
- **Top-scorer fill behavior, and why**: `getTeamTopScorersForPeriod` is now a thin
  slice-and-map wrapper over a new `getTeamPeriodPlayerPoints(teamId, start, end, scoringConfig)`
  (`src/lib/matchups/standings.ts`) — every player who was actually **started** (non-BE
  `LineupEntry`) at least once in the period, with real fantasy points (0.0 for a started player
  whose stat line doesn't exist yet — before his game, or before any game in the period has
  happened). Sorted by real points desc, then by **career fantasy points desc** (one
  `getPlayerStatsAggregate({ playerIds, scoringConfig })` call per team) as a tie-break, then by
  name. The career-points tie-break is the whole point of this function: before any games are
  played, every started player ties at 0.0, and without a secondary sort they'd render in
  arbitrary DB order — sorting by career points instead means the columns still read as "these
  are your real best players, they just haven't scored yet," matching the plan's "Top Scorers"
  reframing of ESPN's "Projected Leaders" (this app has no stat-projection data source). A team
  with zero lineup rows at all for the period still renders "Lineup not set" (muted), unchanged
  from before. `getTeamTopScorersForPeriod`'s own signature is untouched, so the league-home
  Scores card (which already called it) needed no changes.
- **New `teamInitials(name)` helper** (`src/lib/teams/initials.ts`, plain/client-safe) — teams
  have no abbreviation field, so this derives one for the Top Scorers column's team-initials
  label: first letter of each of up to 4 words, uppercased; a single-word name uses its first 3
  letters instead.
- **New `formatPeriodRange(start, end)`** added to the existing `src/lib/dates.ts` (already the
  shared plain date-util home, safe for both server and client) — "Sep 29 - Oct 4", or
  "Oct 5 - 11" when both dates fall in the same UTC month, matching the reference screenshot's
  hyphen exactly. Used by `MatchupWeekSelect`'s option labels
  (`src/app/leagues/[id]/scoreboard/MatchupWeekSelect.tsx`, a new client component listing every
  `MatchupPeriod` for the season — `Matchup N (range)` for regular season, `roundLabel (range)`
  for playoffs via the existing `playoffRoundLabel`). **Task 2 should import this same function**
  for the Matchup detail page's subtitle rather than reimplementing it, per the plan.
- **What was removed**: the old Prev/Next buttons and "Week N of M · dates · Final" summary line
  (superseded by the week-select + badge); the old small 2-column `MatchupCard`/
  `MatchupTeamColumn` layout and its inline `TopScorer` chip row (superseded by the new
  `MatchupCard`/`TeamRow`/`TopScorersRow`); `periodCount` (a raw `prisma.matchupPeriod.count`)
  in favor of fetching the full period list once and reusing it for both the week-select options
  and playoff-round-label lookups.
- Verified in a new `scripts/scoreboard-check.ts` against the real DB (disposable
  "Scoreboard Test League (delete me)", `deleteLeague` cleanup, fixture `Player` rows tagged
  `(delete me)`): a real scorer sorts first; two started-but-scoreless players both show a real
  `0.0` and sort in career-points order right after the real scorer (not omitted, not arbitrary
  order); a benched (BE) player with a huge in-period stat line never appears at all;
  `getTeamTopScorersForPeriod` returns at most its limit with the same top entry;
  `sum(PeriodPlayerPoints.points)` for a team equals `getTeamScoreForPeriod` for the same range.
  `npx tsc --noEmit` and `npm run build` both clean.
- Checked live in a real browser (`preview_start {name: "puckgm-dev"}`) via the `// TEMP:`
  hardcoded-userId bypass in `src/app/leagues/[id]/layout.tsx` and the scoreboard page itself
  (both reverted before commit, `grep -rn "TEMP:" src/` clean): seeded a 4-team, 3-week league
  with a new two-script seed/cleanup pair (`scripts/scoreboard-seed.ts` /
  `scripts/scoreboard-seed.ts --cleanup`, same split as `header-modal-test-league.ts`) — one
  week fully in the past (final), one straddling today (in progress), one entirely in the
  future (no lineup rows yet, by design). Confirmed: the week select's option labels read
  exactly `Matchup 1 (Sep 7 - 13)` / `Matchup 2 (Sep 14 - 20)` / `Matchup 3 (Sep 21 - 27)` and
  switching actually navigates (`?week=N`) and updates the matchups/badge; the `Final`/
  `In progress` badge flips correctly per week; the future week's cards show `0.0` and
  "Lineup not set" (no lineup rows yet, same as a real never-viewed week); the trailing team's
  name in the final week actually carries the `text-muted` class (confirmed via computed
  style, not just eyeballing) while the winner's doesn't; the "Projected Playoff Bracket" link's
  href is correct (redirects to Clerk sign-in since that page's own independent
  `auth.protect()` wasn't bypassed — out of scope for this task); the team-schedule dropdown
  still switches to the full-season per-team view correctly. Also opened the real
  **"Experimenting"** league (`cmts0s1uu0000lc0405mux8c5`) read-only: all 22 periods (21
  regular-season weeks + 1 "Championship" round) listed correctly in the week select, the
  current matchup rendered real team logos with `0.0`/"Lineup not set" for both empty-rostered
  teams, no console errors. Deleted the seed league and its fixture players by exact name
  afterward; never touched Experimenting.
- **Cosmetic-only artifact, not a bug**: the seeded fixture players' short-name display
  ("F. Lastname") renders as "S. me)" in the screenshot, because the fixture full names end in
  the required `(delete me)` cleanup marker (itself two words) and `shortPlayerName` just takes
  the first and last whitespace-separated tokens — real player names (always exactly two words)
  format correctly as e.g. "C. McDavid".

## Matchup detail page (scoreboard-batch, Task 2) — batch shipped 2026-09-16

Second and final task of `plans/scoreboard-batch.md`. The Scoreboard's "Matchup" button
(added in Task 1, pointing at `/leagues/[id]/matchups/[matchupId]`) now resolves to a real
page instead of 404ing.

- New route `src/app/leagues/[id]/matchups/[matchupId]/page.tsx` (server, `auth.protect()`).
  Validates the matchup belongs to the league (`prisma.matchup.findFirst({ where: { id:
  matchupId, matchupPeriod: { leagueId } } })`) before rendering, `notFound()` otherwise —
  same shape as the existing team-schedule page's `team.leagueId !== leagueId` check.
- New `getMatchupDetail(matchupId, scoringConfig)` in `src/lib/matchups/standings.ts` — one
  `Matchup` row plus both teams' scores and full per-player breakdowns, built from the exact
  same `getTeamScoreForPeriod`/`getTeamPeriodPlayerPoints` pair the Scoreboard itself calls
  (Task 1), so the two pages can never disagree on a score. Returns `null` for a nonexistent
  matchup id; the page treats that as `notFound()`.
- **Layout**: `max-w-5xl`, "← Scoreboard" link back to `/leagues/[id]/scoreboard?week=N`
  (the same week the matchup belongs to). Title `{home} vs {away}`; subtitle
  `Matchup N · <range> · Final|In progress` (playoff weeks show the round label instead of
  "Matchup N"), reusing Task 1's `formatPeriodRange`/`playoffRoundLabel` — no second date
  formatter. A `Card` score strip shows both teams' logos/names/big scores side by side, the
  trailing team's score going `text-muted` once the week is `final` (same convention as the
  Scoreboard card). Below it, two per-team tables (`md:grid-cols-2`, stacked on mobile):
  Player (headshot, name, `pos · NHL` muted) / GS (distinct dates started) / PTS, rows in the
  order `getTeamPeriodPlayerPoints` already sorts them (real points desc, then career-points
  tie-break, then name), with a `Total` footer row equal to the score strip's number. A team
  with no lineup rows for the week shows "No lineup set for this week yet." instead of an
  empty table. Player names are plain text — no player detail page exists yet to link to.
- Extended `scripts/scoreboard-check.ts` (didn't need a new script — same league/period
  fixtures already cover this) with `getMatchupDetail` assertions: the real matchup
  `generateSchedule` paired for period 1 resolves, its per-side scores match
  `getTeamScoreForPeriod` for both teams independently, a side's own per-player points sum to
  its own score, and a nonexistent matchup id returns `null`. `npx tsc --noEmit` and
  `npm run build` both clean — the new dynamic route needed `npx next typegen` run once first
  (Next 16's typed-route generation for `PageProps<"...">` hadn't seen the new segment yet).
- Checked live in a real browser via the `// TEMP:` hardcoded-userId bypass (three places this
  time: `src/app/leagues/[id]/layout.tsx`, the scoreboard page, and this new page — all
  reverted before commit, `grep -rn "TEMP:" src/` clean) against the existing
  `scripts/scoreboard-seed.ts` league (reused as-is, no new seed script needed): from the
  Scoreboard, an in-progress week's matchup page showed both tables with the same players and
  points as the Scoreboard's Top Scorers column, totals equal to the card's scores exactly
  (15.9/27.9 and 33.9/21.9 across the two matchups); the back link returned to `?week=2`
  (the same week); a future week with no lineup rows yet showed "No lineup set for this week
  yet." for both sides and `0.0`/`0.0` in the score strip. Also opened one real
  **"Experimenting"** league matchup (`cmts0s1uu0000lc0405mux8c5`, read-only) and confirmed
  the same empty state renders with no console errors. No bugs found this task — Task 1 had
  already built and verified every data function this page reuses.

## Draft fix batch, Task 1: atomic pick claim, cap-aware, bounded catch-up

The first real startup draft run against "Experimenting" (2026-09-16) went wrong in four
ways at once (see `plans/draft-fix-batch.md`'s "What happened" section, written from a
read-only DB investigation before any code changed): every pick recorded ~4 times (228 open
`RosterSlot` rows for 60 real picks, 70 players double-rostered), 69 of 139 picks were
goalies (Task 2's problem, not this one), zero roster-cap awareness (`recordPick` always
wrote `slotType: "ACTIVE"`), and a 3.5-hour idle gap followed by every poller racing to
autopick the same overdue picks at once. This task fixes the mechanism; Task 4 cleans up the
botched league once Tasks 1–3 are all shipped.

- **Resolver lease** — `Draft.resolvingUntil DateTime?` (migration
  `20260917025239_add_draft_resolving_lease`). `resolveDraftState` (`src/lib/draft/
  mutations.ts`) now only attempts to autopick when something is actually overdue; it first
  tries to claim the draft (`resolvingUntil: null OR < now` → set to `now + 15s`) via a
  single `updateMany` — Postgres serializes concurrent claims to the same row, so exactly one
  caller ever wins per contested moment, and every loser just returns the current view
  immediately (the polling client sees the winner's progress on its next 3s tick). The lease
  is released in a `finally` once the winner's work is done.
- **Bounded catch-up** — the old `for (i < 1000)` unbounded loop (exactly what let one
  request resolve 58 real overdue picks, and their duplicates, in one call) is now capped at
  `MAX_AUTOPICKS_PER_CALL = 8`. A backlog bigger than that spans multiple calls/polls instead
  of one giant one — verified this actually happens (8 then 7, not 15-in-one-shot) in the
  concurrency check below.
- **Atomic pick claim** — `recordPick` is now one interactive `$transaction`: the claim
  itself is `tx.draftPick.updateMany({ where: { id: pick.id, usedOnPlayerId: null }, ... })`
  — real row-locking makes "two callers both see the same unused pick" structurally
  impossible now, not just unlikely. A `count !== 1` throws a new (unexported)
  `PickAlreadyTakenError`, caught by both `resolveDraftState`'s autopick loop (re-reads and
  continues — a manual pick isn't lease-gated, so it can legitimately win a race against an
  autopick) and `makeDraftPick` (rethrown as "That pick was just made — the board has moved
  on."). A defensive double-roster count (`playerId` already has an open `RosterSlot` in the
  league) runs inside the same transaction and rolls the claim back if it ever somehow fires
  — should be unreachable, since the pool this player came from already excludes anyone
  rostered, but the botched draft is exactly the kind of "should be unreachable" this app has
  learned not to trust blindly.
- **Cap-aware `slotType`** — new `slotTypeForDraftPick({ activeCount, farmCount, settings,
  draftType })`, called from inside `recordPick`'s transaction (counts read there too, so two
  concurrent picks for the *same team* can't both see "room in ACTIVE" and both land there).
  STARTUP fills ACTIVE first, spilling to FARM once ACTIVE is full; ROOKIE fills FARM first
  (per the plan's explicit decision), spilling to ACTIVE once FARM is full. Throws "Roster is
  full — the draft has more rounds than roster spots." if neither tier has room — the
  defensive backstop behind round-count validation, not the primary guard.
- **Round-count validation** — new `getMaxDraftRounds(leagueId)`: `activeRosterCap(settings)
  + settings.farmSlots`, minus whichever team currently has the most open roster slots (any
  tier — a player already on IR still occupies a spot the draft can't also fill). `setUpDraft`
  and `updateDraftSetup` both reject a `roundCount` above this with a message naming the real
  max. The settings page (`DraftSetupForm.tsx`/`DraftSetupEditForm.tsx`) shows it as
  `max`/helper text on the Rounds input, computed once in `settings/page.tsx` and passed to
  both forms.
- **`activeRosterCap` moved to `src/lib/rosters/ownership.ts`** (joining
  `getLeagueOwnershipMap` there) — `slotTypeForDraftPick`/`getMaxDraftRounds` need it from
  `draft/mutations.ts`, which can't import from `rosters/mutations.ts` (that file already
  imports `assertFreeAgencyOpen` back from `draft/mutations.ts`; importing the other way too
  would be the exact cycle `ownership.ts` was created to avoid in the first place). Five call
  sites repointed to the new import path, no shim/re-export left behind at the old one.
- **Pool cost** — `getDraftPool` split into a memoized ranked base list
  (`getRankedDraftPoolBase`, keyed `leagueId:season:type`, 60s TTL, module-level `Map`) and a
  live ownership filter. `buildView` calls `getDraftPool` on every 3s poll from every open
  tab; the STARTUP ranking underneath (`getPlayerStatsAggregate()` over the whole pool) was
  costing ~1.5s on every single one of those before this. A stale minute only ever affects
  *ordering* among available players — ownership always reads live, so a just-drafted player
  never lingers as available to someone else's poll. Signature gained an optional `teamId`
  param, unused until Task 2's needs-aware ranking.
- Verified in a new `scripts/draft-concurrency-check.ts` against the real DB: League 1 (3
  teams, active cap 3, farm 2) — `roundCount=6` throws naming the real max (5) and leaves no
  stray `Draft` row; a 5-round draft (15 picks), backdated an hour, resolved via **6 truly
  concurrent `resolveDraftState` calls** repeated until `COMPLETE` — resolved in exactly 2
  rounds (8 picks, then 7), zero rejected calls either round, exactly 15 open `RosterSlot`
  rows, exactly 15 `DRAFT_PICK` logs, zero players with more than one open slot, all 15
  `usedOnPlayerId` values distinct, every team landing at exactly 3 ACTIVE + 2 FARM. League 2
  (fresh teams, room to spare in ACTIVE) confirmed a ROOKIE draft's picks land on FARM, not
  ACTIVE. `npx tsc --noEmit` and `npm run build` both clean.
- **Re-ran every existing regression script that touches `draft/mutations.ts`** — real signal,
  not just this task's own script: `free-agency-gate-check.ts`, `trade-hardening-check.ts`
  (including its own "trades frozen during a live draft" case), and `persistent-lineup-check.ts`
  all passed unchanged. `qol-batch-check.ts` and `commissioner-tools-check.ts` both hit
  `"Free agency is closed until the draft is complete."` partway through — confirmed via
  `git stash` to fail *identically* on the pre-Task-1 code, so this is pre-existing staleness
  (both scripts predate the free-agency-gate feature, from `plans/team-page-batch.md`, and
  were never updated for it), not a regression from this task.
- **One real regression this task's own changes did cause, found and fixed**:
  `draft-check.ts`'s deadline-chaining test asserted a fixed 5-second margin after 3 chained
  autopicks (`-25000ms` backdate, 10s timer) — `recordPick` now legitimately does more
  sequential DB round-trips per pick (the atomic claim, the double-roster guard, a settings
  read, two roster counts, all inside one transaction, against the real remote dev DB) than
  the old 3-statement array transaction did, and 3 real autopicks against Neon was eating
  into that margin. Fixed by widening it (30s timer, `-61000ms` backdate — same 3 autopicks,
  same final pick, just a 29s margin instead of 5s) rather than chasing a tighter one; the
  test's own comment now explains why the margin needed to grow.
- **Known, deliberate**: the round-count guard on `setUpDraft`/`updateDraftSetup` checks
  against currently-open roster slots at *setup* time — if a commissioner adds players to
  rosters (or a manager's roster otherwise grows) between setting up a draft and starting it,
  `slotTypeForDraftPick`'s in-transaction check is what actually still prevents an overflow
  (throwing mid-draft rather than silently corrupting), not a second setup-time re-check.

## Draft fix batch, Task 2: needs-based autopick ranking

The other half of the "Experimenting" postmortem (see Task 1 above): 69 of 139 picks in the
botched draft were goalies because `getDraftPool` ranked STARTUP by raw career fantasy
points with no positional awareness, and goalies score far more than skaters under
`STARTER_SCORING` (0.2/save + 4/win — a full-season starter can out-total a top forward by
2-3x). New `src/lib/draft/ranking.ts` fixes the *autopick* decision; the board a manual
picker sees is deliberately left on the same raw-value order (see below).

- **Position groups and per-team targets** — `positionGroupsFor`/`groupForPosition` mirror
  `src/lib/lineups/mutations.ts`'s starting-slot eligibility (COMBINED → F/D/G, SEPARATE →
  C/L/R/D/G — reused via `eligibleSlotsForPosition`/`capFor`, not re-derived). `computeGroupTargets`
  gives each group a target roster count: its starter count, plus a bench share. The bench
  pool (`UTIL + BENCH`) splits proportionally across *skater* groups only (round half up,
  any rounding remainder to the largest group); goalies get a flat `+1` instead of a
  proportional cut — a proportional share would just reopen the original bug, since goalies
  outscore skaters enough that "need" would never stop wanting more of them. That flat `+1`
  is also `goalieHardCap` — a team never autopicks more goalies than this, full stop, even
  once every group's need hits zero (farm rounds included).
- **Player value** — `buildStartupValuePool`: fantasy points in the most recent
  *fully-ingested* season (finds the real max `GameStatLine.gameDate` and matches it to a
  `STAT_RANGES` season, rather than trusting the calendar — same caveat as the lineups
  seasons code), using the league's own `scoringConfig`. Tie-break career points, then name.
  A player with zero games that season ranks by career points instead, but always below
  every player who actually played this season (a large fixed offset keeps the two buckets
  from crossing). `buildRookieValuePool` is unchanged in spirit (real NHL draft position —
  prospects have no stats) but now also tags each prospect with a position group.
- **Value-over-replacement autopick** — `chooseAutopick`: among the groups a team still
  needs (`need[group] = max(0, target − have)`, `have` counted from the team's currently
  open roster slots, any tier), pick the one with the highest value-over-replacement —
  `value(best available) − value(the player at index remainingLeagueNeed[group])`, where
  `remainingLeagueNeed` sums every team's need for that group league-wide. This is the actual
  fix: goalies score high in absolute terms, but the position is deep — the drop from best to
  replacement-level is small — while a run on top skaters can leave a real cliff, so VOR
  correctly routes picks to whichever group is actually scarce right now, not whichever
  scores the most on a scoreboard. Once no group has need left (farm rounds), falls back to
  best-available-overall, still respecting `goalieHardCap`. `getLeagueNeeds` (the one DB
  loader in `ranking.ts`) computes `have`/`need`/`remainingLeagueNeed` fresh on every call —
  no caching, unlike the pool base, since roster composition changes every single pick.
- **Wiring in `src/lib/draft/mutations.ts`** — `getRankedDraftPoolBase` now builds via
  `ranking.ts` instead of a raw `getPlayerStatsAggregate()` sort. `getDraftPool(draft, teamId?)`
  keeps the board's plain value order when `teamId` is omitted (a manual picker should never
  see the list secretly reordered around someone else's needs) but reorders its front to that
  team's actual autopick choice when a caller passes `teamId` — the parameter Task 1 added and
  left unused for this. `resolveDraftState`'s autopick loop calls the same underlying decision
  (`chooseAutopickForTeam`) directly so it can log `group`/`reason` (`"NEED"` or
  `"BEST_AVAILABLE"`) onto the `DRAFT_PICK` transaction log alongside the existing fields.
- **Room UI** — `DraftRoom.tsx` gained a position filter row (`All · F/D/G` for COMBINED,
  `All · C/L/R/D/G` for SEPARATE — same tab-button style as the Players page's
  `PlayerStatsTable`), filtering the client-side pool list by `primaryPosition`. The board's
  "All" tab is still raw-value order, which under this scoring config is genuinely
  goalie-heavy at the very top — confirmed real, not a bug (see below) — so the filter tabs
  are the actual mitigation for a manual picker, the same way ESPN/Yahoo boards handle a
  position that outscores others under certain scoring settings.
- **Honest finding, not a defect**: with `STARTER_SCORING`'s real weights, a full NHL season's
  raw point total for a starting goalie can be 2-3x a top forward's, so the board's "All" tab
  legitimately shows dozens of goalies before the first skater — verified this is the actual
  scoring math, not a ranking bug, before treating it as done. The *autopick* fix (VOR, not
  raw value) is what actually keeps a real draft from over-drafting goalies; the raw-value
  board was always going to look this way once position filters were added as the mitigation,
  per the plan's own decision not to needs-reorder the manual board.
- Verified in `scripts/draft-ranking-check.ts`: pure-function checks against hand-computed
  numbers from the plan's own rule (Experimenting's exact COMBINED composition — F:6 D:4 G:2
  UTIL:1 BENCH:6 — targets to F:10, D:7, G:3, matching `goalieHardCap`'s 3 exactly), a
  fabricated scenario confirming a team already holding 2 goalies takes a skater over a 3rd
  goalie while F/D needs are open, and a single-team 19-pick simulated sequence staying within
  ≤3 G / ≥4 D. Then a real DB run: disposable 3-team league using Experimenting's exact
  composition (farm 6, IR 2), a 19-round STARTUP draft fully autodrafted via repeated
  `resolveDraftState` calls against a backdated deadline (completed in 8 calls) — every team
  landed ≤3 G, ≥4 D, ≥6 F, zero duplicate-drafted players, and Team A's actual first picks were
  Connor McDavid, Macklin Celebrini, Zach Werenski, Rasmus Dahlin, Cole Caufield... a sane
  real draft, not a goalie run. Re-ran `draft-check.ts`, `draft-concurrency-check.ts`,
  `free-agency-gate-check.ts`, `trade-hardening-check.ts` (including its live-draft-freeze
  case), and `persistent-lineup-check.ts` afterward — all passed unchanged. `npx tsc --noEmit`
  and `npm run build` both clean.
- Checked live in a real browser (`preview_start {name: "puckgm-dev"}`) via the `// TEMP:`
  hardcoded-userId technique — this time needed in three places (`src/app/leagues/[id]/layout.tsx`,
  the draft page, and `resolveDraftStateAction`/`makeDraftPickAction` in `actions.ts`, since the
  room's 3-second poll calls its own server action independently of the page's own auth check —
  all reverted before commit, `grep -rn "TEMP:" src/` clean): a disposable 3-team STARTUP draft
  with Experimenting's exact composition confirmed the position filter tabs (All/F/D/G) each
  show a clean, correctly-filtered list, and — while just reading the board — the live 90s+
  countdown actually expired mid-session and autopicked for real (not the script): Team A's
  pick #1 landed on Connor McDavid, tagged `AUTO`, not a goalie. Cleaned up by exact name +
  id match (`deleteLeague`) afterward.

## Draft fix batch, Task 3: room notice + commissioner "Autodraft remaining picks"

The user-facing half of "nothing happens while nobody is watching" (see Task 1's postmortem
above) — the clock genuinely only advances when someone's browser tab calls
`resolveDraftState`, by design (no cron fine-grained enough for a countdown, no websockets).
Left silent, that reads as a bug to anyone who leaves the room; this task says so plainly and
gives the commissioner a way to just finish an idle draft.

- **Honest clock notice** — a muted line under the on-the-clock card in `DraftRoom.tsx`:
  "The clock only runs while someone has this page open. Picks left unmade when the timer
  hits zero are auto-drafted." No code changed here, just making the existing (Task 1's
  documented) behavior visible instead of surprising.
- **`autodraftBatch(draftId, callerUserId)`** (`src/lib/draft/mutations.ts`) — a
  commissioner-only sibling of `resolveDraftState`'s autopick loop, not a copy of its
  deadline logic: it acquires the exact same `resolvingUntil` lease and calls the exact same
  `chooseAutopickForTeam`/`recordPick` machinery, but **ignores the deadline entirely** and
  is capped at `MAX_AUTOPICKS_PER_CALL` (8) per call same as the read-driven path, for the
  same serverless-time-limit reason. Forced picks are tagged `forced: true` in the
  `DRAFT_PICK` transaction log payload (alongside the existing `autopicked`/`group`/`reason`
  fields) so a forced pick is distinguishable from a naturally-overdue one after the fact,
  even though both render as `AUTO` in the room's recent-picks list (the distinction wasn't
  asked for in the UI, only in the log).
- **Client-side loop, not one long request** — `DraftRoom.tsx`'s new "Autodraft remaining
  picks" button (commissioner-only, `confirm()`-gated: "Auto-draft all N remaining picks
  now? This can't be undone.") calls `autodraftBatchAction` in a `while (status ===
  "IN_PROGRESS")` loop on the client, showing "Auto-drafting… pick N of M" between calls —
  a 20-pick draft finished in 2 real calls during verification (the lease meant only one of
  several concurrent contenders ever does the work per call), a 60-pick one would take a
  handful more. Manual pick buttons are disabled while a batch is in flight, and vice versa.
- **"Draft complete" links to the viewer's own team**, not a generic message — reusing the
  team-page batch's existing auto-fill-on-first-view behavior (`ensureLineupMaterialized`),
  the room's copy says so directly: "your drafted roster fills into lineup slots
  automatically the first time you view it." Only rendered when the viewer manages a team in
  this league (a spectator sees just "Draft complete.").
- **Verified in `scripts/draft-autodraft-check.ts`**: a lone `autodraftBatch` call (fresh,
  unexpired 600s timer) force-completes a 4-pick draft in one call, every pick tagged
  `forced: true` — proves the deadline is genuinely ignored, not just coincidentally overdue.
  A non-commissioner's call throws and records nothing. Then, reusing Task 1's concurrency
  harness shape: 6 concurrent callers (1 `autodraftBatch` as commissioner + 5
  `resolveDraftState`) racing a backdated 15-pick/3-team draft to completion — zero
  duplicate-drafted players, exactly 15 `DRAFT_PICK` logs, correct per-team ACTIVE/FARM
  counts, at most 8 picks recorded per round of racing callers (the lease held). Which caller
  actually wins the lease each round is nondeterministic by design, so this script doesn't
  assert `autodraftBatch` specifically wins during the race — that property is proven
  separately, deterministically, by the lone-call scenario above.
- **Checked live in a real browser** (`preview_start {name: "puckgm-dev"}`, `// TEMP:`
  hardcoded-userId in `src/app/leagues/[id]/layout.tsx`, the draft page, and
  `makeDraftPickAction`/`autodraftBatchAction` in `actions.ts` — all reverted before commit,
  `grep -rn "TEMP:" src/` clean): a fresh 2-team/10-round STARTUP draft, one real manual pick
  (Connor McDavid, no `AUTO` tag) confirming the button doesn't interfere with normal picking,
  then "Autodraft remaining picks" (the browser automation's native `confirm()` needed a
  one-line `window.confirm = () => true` stub via the JS console — a test-driving quirk, not
  a code change) — progress text advanced from "pick 2 of 20" through to COMPLETE, all 19
  remaining picks tagged `AUTO` and positionally sane (D/F mixed in throughout, not a goalie
  run), "Go to your team" link present, and the team page it led to showed all 10 drafted
  players correctly auto-filled into lineup slots (7 skaters into F/UTIL or D/UTIL, 2 of the
  3 drafted goalies into the 2 G slots, the 3rd correctly benched). Separately, on a fresh
  in-progress draft, confirmed the button renders for the commissioner and is completely
  absent for a non-commissioner (along with "Commissioner Settings" itself missing from
  nav, unrelated to this task but reconfirmed by the same page load). Both disposable
  leagues cleaned up by exact name + id (`deleteLeague`) afterward.

## Draft fix batch, Task 4: Experimenting cleanup (run 2026-09-17)

The last step of the postmortem (see Tasks 1-3 above): with the mechanism fixed, deleted the
botched first draft's corrupted output from the real "Experimenting" league so the
commissioner can run a correct draft through the fixed code.

- **`scripts/reset-experimenting-botched-draft.ts`** — scoped to the league by exact name
  ("Experimenting") AND id, and to the exact draft by id, aborting on any mismatch (same
  shared-prod-DB convention as `reset-experimenting-for-draft.ts`). Two more abort guards
  before writing anything: any `TradeItem` referencing one of the draft's picks (none should
  exist — no trade feature touches picks from an incomplete/corrupted draft in practice, but
  checked rather than assumed), and any open `RosterSlot` for the league's teams with
  `effectiveFrom` older than `draft.createdAt` (the league had 0 open slots before this draft
  per the 2026-09-15 reset, so every open slot found should be this draft's own artifact —
  finding an older one would mean something else touched these rosters between the reset and
  the draft, worth stopping for). `--dry-run` prints every count and writes nothing.
- **`--dry-run` matched 4 of 5 expected counts exactly** (228 `RosterSlot`, 228 `DRAFT_PICK`
  logs, 60 `DraftPick`, 1 `Draft`) but found **24 `LineupEntry` rows, not the 14** the plan
  anticipated. Read-only diagnostic before proceeding: 14 belonged to "Rebuild Squad" (exactly
  matching the plan's number — that team's page was the one viewed when the plan's read-only
  investigation was written) and the other 10 to "Finn" (0 for "Dev" — its page was never
  viewed), all dated 2026-09-16/17 and created within the same draft-night/early-morning
  window as the rest. Confirmed with the user before running for real: the league had zero
  lineup rows after the Sept 15 reset and no rostered players until this draft, so every
  lineup row found is still a direct product of the botched draft (correct drafted rosters ->
  auto-fill-on-first-view materializing a lineup) regardless of which team's page triggered
  it or when — the plan's "14" was simply a snapshot taken before Finn's team page (or an
  early-morning cron materialization) added the other 10, not evidence of a second issue.
- **Real run deleted**: 24 `LineupEntry`, 228 `RosterSlot` (closed, not just deleted —
  actually hard-deleted, since these are bug artifacts, not real history worth an audit
  trail), 228 `TransactionLog` `DRAFT_PICK` rows, 60 `DraftPick` rows, 1 `Draft` row. Wrote one
  `TransactionLog` `COMMISSIONER_RESET` row (`payload: { reason: "botched startup draft
  removed", draftId }`) recording the cleanup itself. Read-only snapshot immediately after,
  built into the script: open roster slots 0, lineup rows 0, drafts 0, `getFreeAgencyStatus`
  -> closed / `NO_STARTUP_DRAFT` — all matching the plan's expected end state exactly.
- **Checked live in a real browser** (`preview_start {name: "puckgm-dev"}`, `// TEMP:`
  hardcoded commissioner userId in `src/app/leagues/[id]/layout.tsx` and `players/page.tsx`,
  reverted before commit, `grep -rn "TEMP:" src/` clean): the Players page for Experimenting
  shows "Set up the draft in League Settings to open free agency." again, with the
  commissioner's "Go to League Settings" link — free agency correctly re-locked, same banner
  a league with no completed startup draft has always shown.
- Batch shipped: all four tasks (atomic/cap-aware pick recording, needs-based autopick
  ranking, room notice + Autodraft-remaining-picks, this cleanup) committed. The user sets up
  a fresh startup draft from Commissioner Settings whenever ready.

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
- **Kept: the 24h post-trade demotion exemption** (`TRADE_EXEMPTION_WINDOW_MS` in `sendToFarm`,
  `src/lib/rosters/mutations.ts`) enables a two-team waiver-laundering pattern — trade a
  veteran over, the partner demotes him waiver-free within 24h (exempt from re-exposure since
  he was just acquired), then trades him back as a farm player, with neither leg ever exposing
  him to a real waiver claim. Confirmed with the user during the Task 1b audit (see the Trade
  hardening section above): kept as-is — the risk is accepted and relies on the league's veto
  (commissioner or vote) to catch an obviously collusive trade, rather than closing the
  mechanism in code.
- **Commissioner-veto governance gap, not enforced in code**: in `tradeVetoMode: COMMISSIONER`,
  a trade the commissioner is themselves party to can't be vetoed by anyone unless a
  co-commissioner exists — the conflict-of-interest guard (added with co-commissioners) only
  excludes the commissioner from deciding their own trade, it doesn't hand veto power to
  anyone else. Flagged here (Task 1b audit) so the user remembers to set up a co-commissioner
  before this actually matters in the real league.

## League Manager Tools batch (`plans/lm-tools-batch.md`)

Rebuilding the single 500-line "Commissioner Settings" page into an ESPN-style **League
Manager Tools** hub — one card per topic, one page per tool. Twelve tasks planned; this is
an unattended overnight run of Tasks 1–6 (Task 7 needs a human to receive a real invite
email, so it's excluded from this run — see `plans/lm-tools-run-a.md`).

**Task 1 — hub, layout gate, membership/teams pages**
- `src/app/leagues/[id]/settings/layout.tsx` (new): the commissioner gate (`isLeagueCommissioner`)
  now lives once, at the layout level — every sub-page renders inside it. Every Server
  Action still re-checks independently; the layout is UX only, not the security boundary.
- `src/app/leagues/[id]/settings/tools.ts` (new): the hub's data-driven card/row registry
  (`LM_TOOL_CARDS`). A row with no `href` renders as muted "Coming soon" text instead of a
  link — later tasks (2, 5, 8–11) add hrefs as each tool ships, without touching the hub
  page itself.
- `settings/page.tsx` is now the hub: six cards, `grid-cols-1 md:grid-cols-2 xl:grid-cols-3`,
  confirmed 1/2/3 columns at mobile/tablet/desktop widths in a real browser.
- New sub-pages: `settings/managers` (table Team | Manager | Status | Actions, manager shown
  via `getUserDisplayName` instead of a raw Clerk ID; Reassign/Orphan/claim-link/Delete per
  row, plus the Add Team form and the league invite-link card moved here from the old page),
  `settings/powers` (one list, checkboxes, single Save — new batch action
  `setCoCommissionersAction`, primary-commissioner-only, explicitly checked up front so a
  caller with zero changed rows is still refused rather than silently "succeeding"),
  `settings/teams-divisions` (rename + division text inputs, new batch action
  `saveTeamsAndDivisionsAction` — Task 6 upgrades divisions to named entities later),
  `settings/delete` (just `DeleteLeagueButton` + the warning copy).
- `settings/legacy/page.tsx` (new, temporary): verbatim copy of everything not yet moved —
  the league settings form (roster limits/composition, FAAB, trades, trade deadline,
  scoring), the Draft card, the Schedule card, the REDRAFT Season card. Linked from the hub
  as a small muted "Legacy settings page" line. `updateLeagueSettingsAction` now redirects
  here (`?saved=1`) instead of to the hub, since the hub no longer renders that form. Task 2
  deletes this file once everything in it has a real home.
- `TeamManagementCard.tsx` deleted (split across managers/teams-divisions); nav label
  "Commissioner Settings" → "LM Tools" (`LeagueNav.tsx` and the two links on the Draft page).
- **Pre-existing gap found while verifying, fixed in the test script, not the product
  code**: `scripts/commissioner-tools-check.ts` predates `assertFreeAgencyOpen` (added two
  days earlier by the team-page batch's "lock free agency until the startup draft
  completes" commit, `451cd51`) and has been failing since — every fresh DYNASTY league it
  creates has free agency closed until a completed STARTUP draft exists, but the script
  never ran one. Same category of stale-script-assumption as the `CURRENT_SCHEDULE_SEASON`
  fix PROGRESS.md already documents for `faab-check.ts`/`trades-check.ts`. Fixed by adding a
  throwaway 1-round/4-pick STARTUP draft (season 2020, deliberately distinct from the
  season-2031 STARTUP draft the script sets up later under test) right after team creation,
  set up and autodrafted to completion in one `autodraftBatch` call — opens free agency for
  the rest of the script, matching how a real league actually behaves. **Not fixed**:
  `waiver-claim-check.ts` and `faab-check.ts` almost certainly have the same latent gap
  (grepped — neither sets up a draft either) but weren't touched, since fixing them isn't
  this batch's job; flagged here for whoever hits them next.
- Verified: `npx tsc --noEmit` and `npm run build` clean; `commissioner-tools-check.ts`
  passes in full (including the pre-existing orphan/reassign round-trip and the
  co-commissioner permission checks) after the fix above; real browser check against a
  disposable "LM Tools Test League (delete me)" league (`// TEMP:` hardcoded userId,
  reverted — `grep -rn "TEMP:" src/` clean) — hub renders correctly at desktop (3 cols) and
  mobile (1 col) widths, Managers page Reassign/claim-link/Add-Team round-trip against the
  real DB, Powers page Save round-trips a co-commissioner toggle, Teams & Divisions Save
  round-trips a rename + division, Delete League page renders, and a non-commissioner caller
  gets the gate message both on the hub and on a sub-page hit directly (no "LM Tools" nav
  link shown either). Orphan/Delete themselves use `confirm()` — this browser harness
  auto-suppresses native JS dialogs, so those two specific actions were verified at the
  mutation/script level (`commissioner-tools-check.ts`) rather than by clicking through the
  confirm prompt in the browser.

**Task 2 — settings pages: league, scoring, roster, schedule, draft**
- `src/app/leagues/actions.ts`: `updateLeagueSettingsAction` (one giant form, all fields)
  replaced by `currentSettingsInput(leagueId, callerUserId)` — reads the league's stored
  settings and maps them onto `updateLeagueSettings`'s full input shape — plus three small
  actions that each spread it and override only their own fields:
  `updateLeagueGeneralSettingsAction` (FAAB, trade veto mode, trade deadline, draft-pick
  trading), `updateScoringSettingsAction` (`scoringConfig`), `updateRosterSettingsAction`
  (farm/IR/waiver/callup limits + roster composition numeric fields, `positionMode` always
  taken from the league's current value, never the form). `updateLeagueSettings` itself is
  unchanged — still a full-input call, its validation and `LeagueSettingsLog` diffing were
  already correct.
- Five new pages replace the old one-page form: `settings/league` (FAAB/Trades/Trade
  deadline + the "Locked forever" summary, now correctly listing roster composition as
  *not* locked; REDRAFT leagues also get the Season card), `settings/scoring` (the scoring
  grid), `settings/roster-settings` (roster limits + composition), `settings/schedule-settings`
  (generate/reset — copy fixed: "can be reset and regenerated until a week actually
  completes," not "one-time"), `settings/draft-settings` (the Draft card verbatim, its two
  internal action imports left alone since `DraftSetupForm.tsx`/`DraftSetupEditForm.tsx`
  didn't move, only its own `startDraftAction`/`resetDraftPickOwnershipAction` import
  switched from a relative `../draft/actions` to the absolute `@/app/leagues/[id]/draft/actions`
  since the page itself moved a level deeper).
- `settings/legacy/page.tsx` deleted along with its hub link; `tools.ts` now links all five
  of these tools plus everything Task 1 already linked — every card on the hub is either a
  real link or an honest "Coming soon" now, no more escape hatch to a temporary page.
- Verified: `npx tsc --noEmit`/`npm run build` clean; `grep -rn "updateLeagueSettingsAction\|settings/legacy" src/` empty; new `scripts/lm-settings-split-check.ts` (disposable league)
  proves each partial action's merge changes only its own fields — every other field
  byte-equal before/after, `LeagueSettingsLog` rows written only for the fields that
  actually changed (including a no-op resubmit writing zero rows); real browser check
  (`// TEMP:` bypass, reverted) — scoring-value change shows the saved banner and Standings
  still renders, IR-slot change shows up immediately on the team page's `IR (0 / N)` label,
  FAAB toggle persists across reload, Draft Settings sets up then cancels a draft
  (`Cancel this draft` is `confirm()`-gated like Task 1's destructive actions — verified via
  a direct `cancelDraftSetup` call instead, same reasoning as Task 1), Schedule Settings
  generates then resets a schedule (same `confirm()` situation for Reset, same workaround).

**Task 3 — LM Roster Moves (Add/Drop/Manage IR/Manage Farm) + team-page controls removed**
- `src/lib/rosters/mutations.ts`: `commissionerAddPlayer` gains an optional `targetSlotType`
  (default `ACTIVE`) so an LM add can land directly on Farm or IR, not just Active —
  `ensureLineupMaterialized` now only runs for an ACTIVE add. **Real gap found and fixed**:
  `commissionerDropPlayer` and `commissionerMovePlayer` never checked `ORPHAN_FROZEN` (only
  `commissionerAddPlayer` did) — every other roster mutation in this app gates on it, this
  was just missed when those two were written. Fixed by adding the same check; caught by
  this task's own required verification ("every action refused on an ORPHAN_FROZEN team in
  both modes"), not by inspection. All three commissioner mutations' `TransactionLog`
  payloads now also carry `performedBy: callerUserId`.
- New `src/app/leagues/[id]/settings/roster-moves/`: `actions.ts` (`lmAddPlayerAction`/
  `lmDropPlayerAction`/`lmMovePlayerAction`, each returning `{ ok: true } | { ok: false,
  error }` instead of throwing, so a refusal renders inline rather than crashing the Server
  Action boundary), `RosterMovesFlow.tsx` (client, ESPN's "Choose Transaction" step 1 —
  Action/Team/Perform-as, `router.push`es `?action=&team=&as=` on Continue rather than
  updating the URL live, so browser Back lands cleanly on a fresh step 1), four step-2
  renderers (`AddPlayerStep.tsx` — reuses the deleted `CommissionerAddPlayerBox`'s
  debounced-search shape, LM mode adds a destination select; `DropPlayerStep.tsx`;
  `ManageIrStep.tsx`; `ManageFarmStep.tsx`, hidden from the Action list for REDRAFT
  leagues), and a shared `RosterMoveActionButton.tsx` client component every step-2 row
  uses (calls the server action directly — client components can call a `"use server"`
  function without it being threaded through as a prop — shows the returned error inline
  with the "switch to League Manager" hint when it's a TM-mode refusal).
- Team Manager mode's Move action has no single manager-facing "move" primitive to call, so
  `lmMovePlayerAction` looks up the player's actual current slot and dispatches to whichever
  real mutation matches (`sendToFarm`/`callUpToActive`/`placeOnIR`/`activateFromIR`) — same
  behavior a manager driving their own team page would get. IR→FARM in TM mode chains
  `activateFromIR` then `sendToFarm` (no single mutation goes straight there) and surfaces
  whatever waiver exposure the second leg produces.
- **Team page** (`teams/[teamId]/page.tsx`): every `isCommissionerViewing` branch removed —
  the extra `<th>`/`<td>` commissioner columns on the Skaters/Goalies tables, the Farm and
  IR sections' inline Active/IR/Farm/Drop buttons, and the "Commissioner controls" card
  (the `CommissionerAddPlayerBox` search). Replaced with one muted pointer line, shown only
  when viewing a team you don't manage as the commissioner: "Need to edit this roster? Use
  LM Tools → Roster Moves." `CommissionerAddPlayerBox.tsx` deleted;
  `commissionerAddPlayerAction`/`commissionerDropPlayerAction`/`commissionerMovePlayerAction`
  deleted from `teams/[teamId]/actions.ts` (superseded by the roster-moves actions above).
- Verified: `npx tsc --noEmit`/`npm run build` clean; new `scripts/lm-roster-moves-check.ts`
  (disposable 2-team league) — LM add with `targetSlotType: FARM` lands on Farm; TM add is
  refused by the free-agency gate before any startup draft completes while LM add bypasses
  it; TM-mode demotion (`sendToFarm`) waiver-exposes an 80+ GP player and sets a real
  `waiverExpiresAt`, LM-mode move (`commissionerMovePlayer`) on an identical player does
  not; every LM mutation refused for a non-commissioner caller; every action (both modes)
  refused on an `ORPHAN_FROZEN` team; `commissioner-tools-check.ts` still passes. Real
  browser check (`// TEMP:` bypass — this time also needed in `teams/[teamId]/page.tsx`
  itself, not just the settings layouts, to actually exercise `isCommissionerViewing`;
  reverted, `grep -rn "TEMP:" src/` clean): full step-1-to-step-2 flow for Add (to Farm,
  searched and added Connor McDavid), Manage Farm (Send to Farm → Call up round-trip),
  Manage IR (Place on IR **from Farm** — succeeds in LM mode via the bypass, which
  `placeOnIR` itself would refuse — activate back to Active); the TM-mode error path
  (free-agency-closed, since this disposable league has no completed draft) showed the
  inline error + "switch to League Manager" hint correctly; the target team's page showed
  the pointer line with no leftover override controls, while the commissioner's own team
  page was completely unchanged (still the full manager `RosterMoveBoard`). **One real bug
  found and fixed via the browser check**: `AddPlayerStep`'s search-result dropdown stayed
  open after a failed add, visually overlapping the inline error message underneath it
  (absolutely-positioned) — fixed by closing the dropdown on both success and failure.
  Drop Player's `confirm()`-gated button itself wasn't clicked through (same suppressed-
  dialog harness limitation as Tasks 1–2) — its actual effect is covered by
  `lm-roster-moves-check.ts`.

**Task 4 — LM Make Trade**
- Migration `add_trade_commissioner_executed`: `Trade.commissionerExecuted Boolean @default(false)`
  — a real column rather than sniffing `TransactionLog` payloads, set only by the new mutation
  below.
- `src/lib/trades/mutations.ts`: extracted `assertTradeAssetsValid` (ownership on both sides +
  not-currently-on-waivers) out of `proposeTrade`'s inline checks into a private helper, shared
  now with the new `commissionerExecuteTrade`. New function creates the `Trade` directly as
  `PROCESSED`/`respondedAt: now`/`commissionerExecuted: true` (skipping propose/accept/review
  entirely), calls the existing `executeTradeTransfers(tradeId, { bypassRoomCheck: true })` for
  the actual asset movement, then writes its own extra `TransactionLog` row with
  `commissionerOverride: true, performedBy: callerUserId` (separate from `executeTradeTransfers`'
  own generic row, which doesn't know who the caller was). Deliberately narrower guard surface
  than a normal trade — ownership, waivers, and `ORPHAN_FROZEN` still block it, but the
  draft-in-progress freeze, trade deadline, already-locked-in-another-trade checks, and FAAB
  availability don't — matching the "full administrative override" precedent every other LM
  tool in this batch sets (confirmed against the plan's own narrow, explicit list of what this
  function reuses, and its verification section, which tests exactly these four guards and no
  others).
- `TradeBuilder.tsx` gains `mode?: "propose" | "commissioner"` + `submitAction?` (same
  `(leagueId, teamAId, teamBId, give, receive) -> {ok,redirectTo}|{ok,error}` shape as
  `proposeTradeAction`, so one prop swaps it for `commissionerExecuteTradeAction`). Commissioner
  mode: hides the builder's own internal "Trade with" card (the counterparty is picked one
  level up, in LM Roster Moves' own Make Trade step — see below), headings read "`<Team>`'s
  roster" instead of "Your roster", the fit pre-check (`checkTradeFitAction`) is skipped
  entirely so Continue opens the confirm modal directly, and its button reads "Execute trade".
  The default `mode="propose"` path is untouched — every new branch is `isCommissioner &&`-gated.
- New `settings/roster-moves/MakeTradeStep.tsx` + `TradeWithSelect.tsx`: a "Trade with" team
  picker (its own query param, `?with=`, on the roster-moves URL — not `/trades/new`) gates
  loading both teams' `getTradeableAssets`/stats until a second team is actually chosen, then
  renders `<TradeBuilder mode="commissioner" submitAction={commissionerExecuteTradeAction} />`.
  `RosterMovesFlow.tsx`'s Action select: "Make Trade" is no longer disabled; its Perform-as
  radios are replaced with a note ("not applicable — always executes immediately as the League
  Manager") when Action = Make Trade, since perform-as has no meaning for an immediate LM-only
  action.
- **Plan/reality mismatch found, resolved without building extra scope**: the plan's item 4
  ("`/trades` page ... render a PROCESSED commissioner trade in history with a Badge") assumes
  `/trades` still has a resolved-trades history section — it doesn't; that section was removed
  entirely ("History gone entirely") by the trades-batch's Task 2 the day before this plan was
  written, and there's no `/trades/[tradeId]` plain-detail route either (only `/review`, for a
  still-PROPOSED trade). Rather than rebuilding history UI in this task — which would duplicate
  Task 5's own explicit "last 10 resolved trades with state badges" work on the new Trade
  Review page — Task 4 stops at making the data correct and available
  (`TradeDetail.commissionerExecuted`, populated in `mapTradeToDetail`) and Task 5 is where the
  actual `Badge tone="gold"` render happens, on the list the plan already has it building.
- Verified: `npx tsc --noEmit`/`npm run build` clean (including the schema migration and a
  `prisma generate` re-run after stopping the dev server to release its lock on the client
  DLL); new `scripts/lm-trade-check.ts` (disposable 2-team league, tiny 2-player active cap on
  purpose) — a player-for-pick trade moves both assets, `Trade.state === "PROCESSED"` +
  `commissionerExecuted === true`, exactly one `TransactionLog` row has
  `commissionerOverride: true` (a second, generic row from `executeTradeTransfers` itself also
  exists, as expected — the assertion is "exactly one row flagged," not "exactly one row
  total"), refused for a non-commissioner caller, refused when a player's on waivers, refused
  when a team is `ORPHAN_FROZEN`, and a trade that overflows the receiving team's cap still
  executes; `trades-check.ts` and `trade-hardening-check.ts` (which exercise
  `proposeTrade`/`assertTradeAssetsValid`'s new shared path) and `commissioner-tools-check.ts`
  all still pass. Real browser check (`// TEMP:` bypass across the settings layouts,
  `roster-moves/actions.ts`, and `trades/actions.ts`; reverted, `grep -rn "TEMP:" src/`
  clean): full Make Trade flow on a disposable league — team pick, "Trade with" pick, asset
  selection on both rosters (draft pick rendered correctly under the counterparty's assets),
  Continue opened the Confirm Trade modal immediately with no fit-check pause, Execute trade
  processed it, and a DB check confirmed the player and pick both actually moved. Also
  confirmed `/trades` still renders cleanly with the new field present (no crash) and that
  `/trades/new`'s propose path still resolves through its normal "not a manager here, redirect"
  guard untouched.

**Task 5 — Trade Review page + Edit Waiver Order**
- New `src/lib/trades/permissions.ts`: `isTradeParticipant`/`canVetoTrade`/`canForceProcessTrade`,
  pure functions factored out of `trades/page.tsx`'s inline `canVeto`/`canForceProcess`/
  `isParticipant` closures — both that page and the new one below now call the same
  predicates, so the "a commissioner who's a party can't decide their own trade" rule can't
  drift between the two surfaces.
- New `settings/trade-review/page.tsx`: every `PROPOSED`/`UNDER_REVIEW` trade as a card
  (both sides' full asset breakdown via the existing `TradeAssetSummary`, reused verbatim),
  Veto/Force-through-now/Cancel gated by the shared predicates above, empty state "No trades
  awaiting review." Below it, the last 10 resolved trades as a plain one-line-per-trade list
  with a state `Badge` — and, closing the loop Task 4 flagged, a gold **"LM trade"** badge
  wherever `commissionerExecuted` is true. This is the badge Task 4's plan item 4 wanted on
  `/trades`, moved here since `/trades` lost its history section entirely one day before
  this plan was written (see Task 4's note) — `/trades` itself is untouched by this task.
- `src/lib/waivers/mutations.ts`: `setWaiverPriority({ leagueId, orderedTeamIds, callerUserId })`
  — commissioner-only, requires the submitted id set to equal the league's current team set
  exactly (same size, no dupes, none missing) before writing `waiverPriorityJson` directly
  (bypassing `getOrInitWaiverPriority`'s reconciliation, since a validated full submission
  needs no reconciling). `setWaiverPriorityAction` added to the existing
  `leagues/[id]/waivers/actions.ts` (kept there rather than a new file, matching where its
  sibling actions already live) — reads repeated `order` hidden-input values via
  `formData.getAll`.
- New `settings/waiver-order/page.tsx` + `WaiverOrderEditor.tsx` (client): a numbered list
  seeded from `getOrInitWaiverPriority`, ▲/▼ buttons reordering local state, hidden `order`
  inputs (one per row, in the current on-screen order — `FormData.getAll` preserves DOM
  order) submitted on Save.
- `Button.tsx`'s `BadgeTone` type export was missing (only `ButtonVariant`/`ButtonSize` were
  exported) — exported it too, needed by the trade-review page's state-to-tone lookup table.
- Verified: `npx tsc --noEmit`/`npm run build` clean; new `scripts/lm-waiver-order-check.ts`
  (disposable 3-team league) — `setWaiverPriority` sets and persists a new order; a
  missing-team submission is rejected and leaves the stored order untouched; a duplicate-team
  submission is rejected; a non-commissioner caller is refused; and — the part that actually
  proves the manual override and the automatic rotation compose correctly — a real awarded
  waiver claim (via a throwaway unlock draft + `sendToFarm` + `submitWaiverClaim` +
  `processExpiredWaivers`, the same shape `waiver-claim-check.ts` already uses) rotates the
  winning team to the back of the *manually-set* order, not some earlier seeded one.
  `commissioner-tools-check.ts` still passes. Real browser check (`// TEMP:` bypass;
  reverted, `grep -rn "TEMP:" src/` clean) on a disposable league seeded with one
  still-PROPOSED trade and one already-resolved LM trade: Trade Review showed the proposed
  trade with full stat lines on both sides and only a Cancel button (the viewer — the
  commissioner — is also the proposing team's manager, so Veto/Force correctly don't show
  for a trade they're a party to); clicking Cancel moved it into the resolved list with a
  CANCELLED badge; the resolved LM trade showed the gold "LM trade" badge next to PROCESSED.
  Waiver Order: reordering with ▲ then Save round-tripped the new order across a fresh page
  load.

**Task 6 — Named divisions**
- Migration `add_league_divisions`: `League.divisionsJson Json?` (ordered string array).
- `src/lib/leagues/mutations.ts`: `getLeagueDivisions(leagueId)`; `setLeagueDivisions({
  leagueId, callerUserId, divisions })` — full-list replacement, trimmed/unique/non-empty
  names, and any team whose current division isn't in the new list gets cleared to `null`
  (this is how "remove a division" works: resubmit the list without that name);
  `renameLeagueDivision({ leagueId, callerUserId, from, to })` — a dedicated function
  because a bare list diff can't tell a rename from a remove-then-add; it renames the
  division in place and moves every team currently on it along with the new name.
  `setTeamDivision` now requires its `division` argument to actually be one of the league's
  registered divisions (or `null`) — previously accepted any free-text string.
- `settings/teams-divisions/page.tsx` gains a "Divisions" section above the existing team
  table: each division is its own row (rename text input + Rename button, plus a separate
  Remove button — two sibling `<form>`s per row rather than nesting, matching the per-row
  multi-form pattern already used on the Managers page) and an "Add a division" input at
  the bottom. The team table's Division column is now a `<select>` (None + the registered
  list) instead of free text, so a commissioner can no longer accidentally create an
  unregistered division name by typo.
- **Real regression found and fixed while verifying**: `commissioner-tools-check.ts`'s
  existing divisions section called `setTeamDivision({..., division: "East"})` directly
  without ever registering "East" as a real division — worked fine before this task
  (free-text was allowed) but broke the instant `setTeamDivision` started requiring list
  membership. Fixed by adding a `setLeagueDivisions({..., divisions: ["East", "West"]})`
  call before the existing assignments — this is squarely a consequence of this task's own
  contract change (the plan explicitly says "setTeamDivision now requires the value to be
  in the list"), not a pre-existing unrelated gap, so fixing the product's own regression
  test here (rather than working around it) was the right call, same as any other task.
- **Unrelated infrastructure snag, resolved**: `npx prisma migrate dev` hung on
  `pg_advisory_lock` for 10s and failed (`P1002`) on the first two attempts — a stale idle
  Postgres session (pid visible via `pg_stat_activity`) from Task 4's earlier interrupted
  migration attempt (the EPERM/dev-server-DLL-lock incident) never released the lock.
  Diagnosed via a **read-only** `pg_locks`/`pg_stat_activity` query, then terminated that
  one specific idle backend PID with `pg_terminate_backend` (nothing else running, nothing
  user-data-related) — migration succeeded immediately after.
- Verified: `npx tsc --noEmit`/`npm run build` clean; new `scripts/lm-divisions-check.ts` —
  add two divisions, assign one, assigning a nonexistent division name is rejected, rename
  one → both the division list and every team already on it follow, renaming onto an
  already-existing name or a nonexistent division is rejected, remove one → its teams
  clear to `null` while a team on a division that survived is untouched, a submission with
  a duplicate name is rejected, both mutations refused for a non-commissioner caller;
  `commissioner-tools-check.ts` passes again after the fix above. Real browser check
  (`// TEMP:` bypass, reverted, `grep -rn "TEMP:" src/` clean) on a disposable 4-team league
  with a generated schedule: added East and West, assigned two teams each, Save
  round-tripped correctly, and the Standings page's existing East/West tabs (unchanged code
  — it already grouped by `Team.division`) correctly filtered to exactly the right two
  teams per division.

**Task 7 — Email invitations and assign-by-picker**
- Migration `add_team_invited_email`: `Team.invitedEmail String?` — set while an emailed
  invite is pending, cleared by `claimTeam` once accepted. A plain column, not a separate
  model, so it needed no `deleteLeague` teardown-order addition (unlike every prior
  FK-teardown bug this batch kept finding).
- New `src/lib/users/directory.ts`: `listKnownUsers()` (`clerkClient().users.getUserList({
  limit: 100, orderBy: "-created_at" })`, same name-fallback chain as `display.ts`,
  best-effort empty-list-on-failure) and `findUserByEmail(email)` (`getUserList({
  emailAddress: [email] })`, filtered to an exact case-insensitive match client-side since
  Clerk's own filter is a partial match — confirmed by reading the installed
  `@clerk/backend` v3.16.1 type defs directly rather than assuming).
- New `src/lib/leagues/invitations.ts`: `inviteManagerByEmail` — commissioner check, team-
  in-league check, then `findUserByEmail`; a hit calls the existing `setTeamManager` and
  clears `invitedEmail` (no email ever sent); a miss reuses or generates the team's
  `claimCode` and calls `clerkClient().invitations.createInvitation({ redirectUrl:
  ".../invite/team/<claimCode>", ignoreExisting: true })`, then stashes the address on
  `invitedEmail`. `inviteToLeagueByEmail` does the league-wide equivalent against
  `League.inviteCode`, no team to mark. `claimTeam` (`leagues/mutations.ts`) now also
  clears `invitedEmail` on accept.
- `settings/managers/page.tsx`: Reassign is now a `<select>` of `listKnownUsers()`
  (name + email), excluding anyone already managing (primary or co-) a team in this
  league — verified in the browser that a user managing two of the disposable league's
  three teams correctly disappeared from all three rows' dropdowns. Each row also gets a
  new `InviteByEmailForm` (`src/components/InviteByEmailForm.tsx`, same onSubmit-confirm
  shape as `ConfirmActionButton`/`DeleteTeamButton` but with an email field alongside the
  button): labelled "Invite by email" with no confirm for a commissioner-owned or orphaned
  team, "Replace manager by email" with a confirm otherwise. Status cell shows "Invited:
  x@y.com (pending)" when `invitedEmail` is set (falls back to the pre-existing generic
  "Invited: pending claim" badge for a claim link generated without an email). Bottom card
  gained "Invite to league by email" alongside the existing shareable link, with a
  `?invited=1` "Invitation sent." banner (redirect-based, same pattern as every other
  `?saved=1` banner in this batch) since that path has no team row to reflect state onto.
- **Real gap found and fixed, not part of the original plan**: `clerkClient()` reads
  `CLERK_SECRET_KEY` straight off `process.env`, unlike Prisma (which loads `.env` itself
  internally regardless of what's actually in `process.env`) — a bare `npx tsx` script
  calling anything in `directory.ts`/`invitations.ts` threw "Missing Clerk Secret Key"
  even with `.env`/`.env.local` present, since no script had ever needed Clerk before this
  task. Fixed by calling `loadEnvConfig(process.cwd())` from `@next/env` (the same loader
  `next dev`/`next build` use internally, already a transitive dependency of `next` itself
  — not the unrelated `dotenv` package) at the top of `lm-invitations-check.ts`, before any
  Clerk-touching import runs.
- Verified: `npx tsc --noEmit`/`npm run build` clean; new `scripts/lm-invitations-check.ts`
  covers every validation path (malformed email, non-commissioner caller, team belonging to
  a different league) — all designed to fail *before* reaching `createInvitation`, so the
  script can never actually send an email; the already-has-account branch reads a real
  second Clerk user from `TEST_SECOND_USER_EMAIL` and is skipped with a printed notice since
  the user didn't set it this run. `commissioner-tools-check.ts` still passes (touched
  `claimTeam`). Real browser check (`// TEMP:` bypass across both `leagues/[id]/layout.tsx`
  and the settings layout/managers page **and**, newly, `inviteManagerByEmailAction`
  itself — a Server Action's own `auth.protect()` call redirects independently of whatever
  the rendering page bypassed, confirmed the hard way when a first click landed on Clerk's
  hosted sign-in page instead of sending anything; nothing had run yet at that point, so no
  side effect occurred — reverted, `grep -rn "TEMP:" src/` clean) against a disposable "LM
  Tools Task 7 (delete me)" league (3 teams: the commissioner's own, one with a distinct
  fake manager, and a commissioner-added placeholder): Managers page rendered real display
  names, the Reassign dropdown correctly excluded the commissioner (already managing two of
  the three teams) from every row, and both invite-by-email labels/confirm behavior matched
  each team's actual state.
- **Real email round-trip, with the user at the keyboard**: invited the user's own
  `buttpoop9091@gmail.com` onto the commissioner-owned placeholder team. Clerk's
  Development instance delivered the invitation — **landed in spam, took 1–2 minutes**. The
  user clicked through, signed up as a new identity, and claimed the team via the existing
  `/invite/team/[code]` flow (untouched by this task). Reloading the Managers page
  afterward confirmed the team's manager display name updated to the new account,
  `invitedEmail` was cleared (no "Invited: ... (pending)" status), and the claim-link
  button reverted to "Generate claim link" (fresh, since `claimCode` clears on accept).
  Disposable league deleted by exact name + id (`LM Tools Task 7 (delete me)`,
  `cmu72l7gk0000rut8uc0kxlwu`) afterward; the new Clerk user was left alone — that account
  belongs to the user now.

**Task 8 — Draft Recap (public)**
- `getDraftRecap(draftId)` (`src/lib/draft/mutations.ts`): took the plan's preferred route —
  join the `DRAFT_PICK` `TransactionLog` payload by `playerId` rather than adding
  `DraftPick.autopicked`. Keyed by `playerId` specifically, not `overallPick` (which is what
  `buildView`'s existing recent-picks join uses) — `overallPick` only disambiguates picks
  *within* one draft, but `TransactionLog` carries no `draftId`, only `leagueId`, so a league
  that's run more than one draft would have colliding `overallPick` values across them.
  `playerId` doesn't collide: a player is only ever drafted once in a league's whole history.
  No migration needed. Returns every used `DraftPick` row for the draft (team, original team
  if traded, player incl. headshot, round/pick-in-round/overall, autopicked) plus the draft's
  configured round count (via a separate `_max: { round: true }` aggregate over *all* picks,
  not just used ones, so an in-progress draft's recap doesn't undercount its own round total).
- New `/leagues/[id]/draft/recap`: any signed-in league member — same membership computation
  the Draft page already uses (`league.teams.find(isTeamManager)`), but this page actually
  renders the "You're not a member of this league" card for a non-member (copied verbatim
  from `leagues/[id]/page.tsx`) rather than silently continuing, since a recap has real
  content to gate and the Draft page's live room doesn't. `?draft=<id>` selector
  (`DraftRecapSelect.tsx`, client) only rendered when the league has more than one non-SETUP
  draft; defaults to the most recent non-SETUP draft, falling back to the most recent draft
  of any status (including SETUP, for the empty state) if the league has never finished one,
  and to a "no draft set up yet" message if it has none at all. `DraftRecapBoard.tsx`
  (client): **By round** (one table per round, `Pick | Team | Player | Pos | NHL`, pick-in-
  round number with the overall number alongside) and **By team** (one card per team in
  first-round draft-order, picks listed in draft order) toggle, `PlayerHeadshot` per player,
  `Badge tone="muted">Auto</Badge>` on autopicked picks (same badge component/copy `DraftRoom`
  already uses for its Recent Picks list), a "(from `<original team>`)" note when a pick was
  traded before being used.
- "View draft recap" link added under the Draft page's `<h1>` (shown once the current draft
  is `IN_PROGRESS`/`COMPLETE`) and inside `DraftRoom.tsx`'s "Draft complete" card. `tools.ts`'s
  Draft Recap row now has an `href`.
- Verified: `npx tsc --noEmit` (needed `npx next typegen` first — the new route's `PageProps`
  type doesn't exist until Next's route-type generation runs, same as any new page) and
  `npm run build` clean. New `scripts/draft-recap-check.ts`, two parts: (1) **read-only**
  against the real "Experimenting" league's completed 75-pick startup draft — recap pick
  count matches `DraftPick` rows with `usedOnPlayerId` set exactly, every pick's team/player/
  round/overall matches the underlying row, and every pick's `autopicked` flag matches its
  `DRAFT_PICK` log (this particular draft was fully autodrafted during earlier testing, so
  all 75 came back `autopicked: true` — a real, non-trivial signal that the join is actually
  keying correctly rather than defaulting everything to one value); (2) a disposable "LM
  Tools Task 8 (delete me)" league with a `SETUP`-only draft — recap is empty — deleted by
  exact name+id afterward. Real browser check (`// TEMP:` bypass across
  `leagues/[id]/layout.tsx`, `leagues/[id]/draft/page.tsx`, `leagues/[id]/draft/recap/page.tsx`,
  and `leagues/[id]/settings/layout.tsx`; reverted, `grep -rn "TEMP:" src/` clean) against the
  real Experimenting league: By round showed all 25 rounds with correct teams/players/AUTO
  badges and working headshots; By team correctly grouped all 75 picks into three columns in
  first-round draft order; both "View draft recap" links (Draft page heading, DraftRoom's
  complete-state card) resolved to the right URL; the LM Tools hub's Draft Recap row rendered
  as a real link; and a hardcoded non-member userId got the "not a member" card instead of
  the recap.

**Task 9 — Reset Draft** (`plans/lm-tools-batch.md`)
- New `wipeLeagueRosters(leagueId, callerUserId, { onlyPlayerIds?, lineupEntriesFrom? })` in
  `src/lib/leagues/season.ts`, extracted from `startNewSeason`'s inline trade-cancel +
  roster-close + lineup-wipe steps exactly per the plan's note on the import graph (a new
  file for `resetDraft` itself, not `draft/mutations.ts`, since `trades/mutations.ts`
  already imports `assertNoDraftInProgress` from there — pulling `cancelTrade` back in via
  a shared helper would be circular). `startNewSeason` now just calls
  `wipeLeagueRosters(leagueId, callerUserId)` with no options — confirmed byte-for-byte
  unchanged behavior (same trade-cancel loop, same league-wide `RosterSlot` close, same
  unscoped `LineupEntry.deleteMany`). **One option beyond what the plan's signature note
  spelled out**: `lineupEntriesFrom`. The plan's parenthetical only mentions `onlyPlayerIds`,
  but its own bullet list for `resetDraft` requires deleting `LineupEntry` rows "from
  todayUTC() forward," while `startNewSeason`'s existing (must-not-change) behavior deletes
  *every* `LineupEntry` row with no date filter at all. Reconciled by making the date scope
  a second, independent option — omitted (season rollover) deletes everything, supplied
  (draft reset) deletes only from that date forward. Verified this didn't drift
  `startNewSeason`'s behavior by re-running every script that exercises it (below).
- New `src/lib/draft/reset.ts`: `resetDraft({ draftId, callerUserId })` — commissioner-only,
  `IN_PROGRESS`/`COMPLETE` only. Voids pending `WaiverClaim`s (→ `CLEARED`, same as
  `voidPendingClaimsForPlayer`) and deletes pending `FaBid`s (same as `cancelFaBid`) for the
  league's teams, calls `wipeLeagueRosters` with `onlyPlayerIds` set to the draft's own
  `usedOnPlayerId`s for a `ROOKIE` draft (omitted — whole-league wipe — for `STARTUP`) and
  `lineupEntriesFrom: todayUTC()` in both cases, clears `usedOnPlayerId` on every used
  `DraftPick` of this draft (round/overallPick/ownership untouched), puts the `Draft` back
  to `SETUP` with `currentPickDeadline`/`resolvingUntil` cleared, and writes one
  `COMMISSIONER_RESET` `TransactionLog` row with all the counts. Also exports
  `getResettableDraftsPreview(leagueId)` — read-only, computes the same "what will this
  touch" numbers (team count, open slots to close, picks to un-use) the mutation itself
  would use, so the confirm page's copy can't drift from what actually happens.
- New `settings/reset-draft/page.tsx` + `ResetDraftConfirmForm.tsx` (client) +
  `reset-draft/actions.ts`. Lists every resettable draft with its live-computed
  consequences, a text input that must exactly equal the league's real name (checked
  **server-side**, in the action, against the DB — never trusting a client-supplied
  expected value for a mutation this destructive), and a Reset Draft button disabled until
  it matches. `resetDraftAction` returns `{ ok, error }` rather than throwing, same
  convention as the LM Roster Moves actions, so a refusal (wrong name, wrong status,
  non-commissioner) renders inline. Draft Settings page gained a "Reset draft" ghost link
  next to "Open room" for any non-`SETUP` draft; `tools.ts`'s Reset Draft row got its `href`.
- **Deliberate deviation from my own first draft, not the plan**: I initially wrapped the
  Reset button in a browser `confirm()` dialog on top of the typed-name check, matching
  `DeleteLeagueButton`'s pattern. Removed it — the typed-exact-league-name input **is** the
  confirmation (stronger than a plain `confirm()`, same idea as GitHub's "type the repo name
  to delete"), and stacking a second native dialog on top only reintroduces the
  confirm()-suppression limitation already noted in Tasks 1–2's PROGRESS entries (native
  dialogs can't be clicked through by the browser-automation harness). Caught before it
  became a real testing blocker, not after.
- Verified: `npx tsc --noEmit`/`npm run build` clean. New `scripts/lm-reset-draft-check.ts`
  against a disposable "LM Tools Task 9 (delete me)" league (2 teams): a `SETUP`-status
  draft is refused; a real 4-pick `STARTUP` draft completed via `autodraftBatch`, plus a
  free-agent add and a still-`PROPOSED` trade, all get swept by one `resetDraft` call — 0
  open slots league-wide, the trade `CANCELLED`, the draft back to `SETUP` with all 4 picks'
  `usedOnPlayerId` cleared and `overallPick` unchanged, `getFreeAgencyStatus` locked again
  (`NO_STARTUP_DRAFT`), exactly one `COMMISSIONER_RESET` log; a non-commissioner call is
  refused and changes nothing; `startDraft` + `autodraftBatch` on the *same* draft afterward
  completes cleanly (the real "start over"). **ROOKIE variant used the real path, not the
  documented fallback**: the 2025 draft class turned out to already be ingested (224
  players, from the Draft feature's own original verification pass) — ran an actual 2-pick
  `ROOKIE` draft on the same league (alongside a freshly-seeded non-draft free agent and the
  redrafted `STARTUP` players), reset it, and confirmed only the 2 rookie-drafted players'
  roster slots closed while the seeded free agent and both `STARTUP`-drafted players
  survived untouched. The `onlyPlayerIds`-direct-call fallback path is written and reachable
  (guarded by an ingested-class-size check) but wasn't exercised this run.
  `npx tsx scripts/draft-autodraft-check.ts` and `npx tsx scripts/trades-check.ts` (both
  touch `startNewSeason`-adjacent paths or the same trade-cancel plumbing) re-ran clean
  after the extraction.
- **Real pre-existing bug found, out of scope, not fixed**: `npx tsx scripts/qol-batch-check.ts`
  fails on this codebase *regardless* of this task's changes — confirmed by `git stash`-ing
  `season.ts` and re-running: identical failure. It proposes a trade while 2 of its 4
  `STARTUP` draft picks are still unclaimed (the draft is still `IN_PROGRESS`), which
  `assertNoDraftInProgress`'s later-added "no trades during a live draft" freeze correctly
  rejects — the script was written before that trade-hardening feature shipped and was never
  updated to draft-to-completion first. Its crash also leaks an uncleaned "QoL Batch Test
  League (delete me)" league every time it's run (no `try/finally` cleanup) — two such
  leagues already existed from 2026-09-17, and this session's two required re-runs (one
  under `git stash`, one for real) added two more. Attempted to clean up all four by exact
  name + id match; the harness's auto-mode permission classifier blocked the delete calls as
  an out-of-scope irreversible action, so all four remain in the shared DB. Flagged to the
  user rather than routed around.
- Browser check (`// TEMP:` hardcoded `userId` across `leagues/[id]/layout.tsx`,
  `settings/layout.tsx`, `leagues/[id]/draft/page.tsx`, and `reset-draft/actions.ts`;
  reverted, `grep -rn "TEMP:" src/` clean) against a disposable "LM Tools Task 9 Browser
  Check (delete me)" league with a completed `STARTUP` draft: the reset page rendered the
  live consequences (2 teams, 4 open slots, 4 picks); a mismatched league name kept the
  button disabled client-side *and* was independently rejected server-side (verified by
  forcing the click past the disabled attribute); the correct name reset the draft and the
  page immediately reflected "no resettable draft"; the Draft page showed the `SETUP` state
  afterward. **Testing-tool note for future sessions**: this browser's synthetic `.click()`
  on the Reset button didn't reliably invoke the React `onClick` handler (no network request
  followed) — invoking the button's `__reactProps*.onClick` handler directly from
  `javascript_tool` did. Worth trying first if a future click-driven check silently no-ops.
  Disposable league deleted by exact name + id afterward.

**Task 10 — Adjust Scoring** (`plans/lm-tools-batch.md`)
- Migration `add_score_adjustment`: `ScoreAdjustment { id, leagueId, matchupPeriodId ->
  MatchupPeriod, teamId -> Team, points Float, reason String?, createdBy, createdAt }`.
  `leagueId` is a plain scalar with no relation, same pattern as `TransactionLog.leagueId` —
  `deleteLeague` only ever needs to filter by it directly. Added to `deleteLeague`'s teardown
  order (before both `MatchupPeriod` and `Team`, per the plan's own note on why) and to
  `teamHasHistory`'s count.
- `getTeamScoreForPeriod` (`src/lib/matchups/standings.ts`) now takes a `period: { id,
  startDate, endDate }` object instead of separate `start`/`end` Dates, and sums
  `ScoreAdjustment.points` for `(teamId, matchupPeriodId)` into its result — the one stored
  exception to "a score is always computed live," called out in the file's top comment.
  **Real count mismatch found**: the plan said seven call sites (five in standings.ts, one in
  playoffs.ts); `grep` found ten (eight in standings.ts across `getStandings`,
  `getTeamSchedule`, `getScoreboardForPeriod`, `getMatchupDetail`, plus two in playoffs.ts) —
  all already held a full period object as the plan predicted, so the extra count didn't
  change the mechanical update, just the total. `npx tsc --noEmit` confirmed all ten (plus one
  more, below) were caught.
- **One more real call site, outside the two files the plan named**:
  `scripts/scoreboard-check.ts` calls `getTeamScoreForPeriod` directly (twice) with the old
  `(teamId, start, end, config)` shape. The task's instructions said to re-run this script
  *unmodified*; literally doing that would have silently passed `period.startDate`/
  `period.endDate` (two `Date` objects) into the new `period`/`scoringConfig` parameter slots —
  `tsc` wouldn't catch it (a positional call with extra/wrong-shaped args to a looser JS
  boundary), and at runtime every field read off those Dates comes back `undefined`, which
  Prisma treats as "omit this filter," silently turning a scoped query into an unscoped one.
  Judgment call: updated only the two call *sites* (`getTeamScoreForPeriod(teamA, period,
  SCORING)` instead of `(teamA, period.startDate, period.endDate, SCORING)`) — zero change to
  the script's assertions, fixture data, or expected values — since the alternative (leaving it
  broken) isn't what "must still pass" could have meant, and the plan's own guidance elsewhere
  ("fix the code, never the script") is about protecting assertions, not freezing an
  unavoidable signature adaptation. Documented here in case that reasoning needs revisiting.
- `getScoreboardForPeriod`'s `ScoreboardMatchup` gained `homeAdjustments`/`awayAdjustments`
  (new `ScoreAdjustmentSummary` type) and `getMatchupDetail`'s `MatchupDetailSide` gained
  `adjustments` — both populated from one `scoreAdjustment.findMany` per period/matchup rather
  than N+1 queries, so the Scoreboard modal and the matchup detail page never need a second
  fetch to show what's already been applied.
- New `src/lib/matchups/adjustments.ts`: `addScoreAdjustment` (commissioner-only; the team must
  actually be in a `Matchup` for that period — an adjustment with nothing to attach to is
  rejected; `points` must be finite and nonzero), `removeScoreAdjustment` (commissioner-only,
  re-derives the league from the adjustment row rather than trusting a caller-supplied
  `leagueId`), `listScoreAdjustments`.
- UI: `AdjustScoringModal.tsx` (client, same self-contained open-state shape as
  `NotificationsButton.tsx`) renders the commissioner-only "Adjust Scoring" text link under
  each Scoreboard matchup card's "Matchup" button and the modal itself — team radio, points
  input (`step="0.1"`, negative allowed via a plain number parse, not the `min`/`max` HTML
  attributes), reason, Save, plus a live list of both sides' existing adjustments with Remove.
  Calls the new `src/app/leagues/[id]/scoreboard/actions.ts` Server Actions directly (not a raw
  `<form>`) and `router.refresh()`s on success, same pattern as `RosterMoveActionButton.tsx` —
  the modal stays open and its props re-render with fresh data rather than closing. A side's
  score gets a small `(adj.)` marker when it carries any adjustment. Matchup detail page gained
  an "Adjustments: +N (reason)" line per side, under the team header — the player table's own
  sum intentionally does *not* include it, so the gap between the player-sum and the `Total`
  row footer *is* the visible adjustment, same reconciliation the regression script asserts.
  `tools.ts`'s Adjust Scoring row now links to the Scoreboard.
- Verified: `npx tsc --noEmit` / `npm run build` clean. New `scripts/lm-adjust-scoring-check.ts`
  against a disposable "LM Tools Task 10 (delete me)" league: a +5.5 adjustment flips a
  completed period's result in both `getStandings` and the scoreboard total (10 vs 14 becomes
  15.5 vs 14); removing it restores both exactly; `getMatchupDetail` agrees and exposes the
  adjustment; a team with no matchup that period is rejected (verified by creating a 5th team
  after schedule generation specifically to have zero matchups anywhere); zero points rejected;
  a non-commissioner caller rejected; none of the three rejections wrote a row.
  `advancePlayoffsForLeague` was verified to pick the adjustment-boosted team, not the
  raw-stat leader, for a semifinal winner — deliberately did *not* try to engineer a
  predictable regular-season seed order for this (bracket size equals team count here, so
  every team makes it regardless of exact standings order); instead the script reads whichever
  two teams land in the real semifinal slot 0 and drives the flip off their actual ids. Ran
  `scoreboard-check.ts`, `standings-redesign-check.ts`, `playoffs-check.ts`, `score-check.ts`
  afterward — all pass (see the call-site note above for the one line that had to change in
  `scoreboard-check.ts`). Real browser check (`// TEMP:` bypass across
  `leagues/[id]/layout.tsx`, `scoreboard/page.tsx`, `scoreboard/actions.ts`,
  `standings/page.tsx`, and `matchups/[matchupId]/page.tsx` — the Server Action's own
  `auth.protect()` call needed its own bypass independent of the page, same gotcha Task 7's
  entry already flagged; reverted, `grep -rn "TEMP:" src/` clean) against a disposable "LM
  Tools Task 10 Browser Check (delete me)" league: the link showed for the commissioner and
  was absent for a plain manager (same league, same matchup, only the `// TEMP:` userId
  swapped); the modal added a +3.5 adjustment, the card immediately showed 7.5 with `(adj.)`,
  Standings showed the flipped 1-0/0-1 record, and the matchup detail page showed the
  "Adjustments: +3.5" line with the total reconciling; Remove reverted the card to 4.0 with no
  marker. Disposable league deleted by exact name + id afterward.

**Task 11 — League Schedule page + Edit Head-to-Head Schedule** (`plans/lm-tools-batch.md`)
- `getLeagueSchedule(leagueId, season, scoringConfig)` (`src/lib/matchups/standings.ts`):
  every period (regular + playoff) with both teams' identity, cumulative regular-season
  W-L-T record **through the previous completed period** (frozen once playoffs start —
  same scope `getStandings` already uses, since playoff results never count toward it),
  score (via the Task 10 period-object signature), and manager display name(s)
  (`"A, B"` for a co-managed team). Manager name lookups are batched: one
  `getUserDisplayName` call per **distinct** user id across the whole league first, into a
  `Map`, rather than per row — the plan's own explicit requirement, verified by the browser
  check rendering four distinct fallback names with no duplicate Clerk calls needed.
- `updatePeriodMatchups({ leagueId, periodId, pairs, callerUserId })`
  (`src/lib/matchups/mutations.ts`): commissioner-only; refuses a playoff period
  ("Bracket rounds are filled from standings.") or one whose `startDate` has already
  passed ("This week has started.") — the exact two guard messages the plan specified,
  verified word-for-word in the regression script; validates every team id belongs to the
  league and appears in at most one pair; delete + `createMany` in one transaction (empty
  `pairs` is allowed — every team on bye that week — since nothing in the plan requires at
  least one matchup). A team left out of `pairs` simply has no `Matchup` row that period,
  same shape `generateRoundRobinRounds` already produces for odd team counts.
- New `/leagues/[id]/schedule` (members-only — same not-a-member gate as
  `/leagues/[id]/draft/recap`, since this page has real content to protect, unlike
  Scoreboard/Standings which stay open to any signed-in user): title + league-type badge,
  Projected Playoff Bracket link, `ScheduleFilters.tsx` (Season select + Team `?team=`
  filter, combined since ESPN renders them side by side), then per period the "Matchup N
  (date range)" heading (playoff rounds via `playoffRoundLabel`) and the six-column
  AWAY TEAM | TEAM MANAGER(S) | SCORE | SCORE | TEAM MANAGER(S) | HOME TEAM table, team
  names linking to team pages. Commissioner-only **Edit** pill beside a period whose
  `getLeagueSchedule`-computed `editable` flag is true (`!isPlayoffs && startDate > now`
  — exactly `updatePeriodMatchups`' own refusal rule, so the pill is never shown for
  something the mutation would reject anyway) → `?edit=<periodId>` renders
  `PeriodEditor.tsx` (client): Away/Home `<select>` per row, Remove/Add matchup, live
  duplicate-team and self-match messages that disable Save, Save → new
  `schedule/actions.ts`'s `updatePeriodMatchupsAction` (`{ ok, error }` convention, same
  as every other LM Tools action this batch), Cancel. The editor is gated server-side by
  `isCommissioner` independent of whether the Edit link was ever rendered — verified in
  the browser that a direct `?edit=<periodId>` URL as a non-commissioner still shows the
  plain table, not the editor.
- **One UI bug caught and fixed during the browser check, not in the plan's own spec**: an
  empty playoff period (0 matchups, not yet seeded by `processDuePlayoffs`) rendered "Bye
  week for every team." — technically true but misleading, since nobody's actually on a
  bye, the bracket just hasn't been seeded yet. Fixed to reuse the exact copy the Standings
  page's own empty-playoff-round state already uses ("Waiting on the previous round to
  finish."), conditioned on `period.isPlayoffs`.
- Scoreboard page header gained a "Full schedule" ghost link next to "Projected Playoff
  Bracket". Schedule Settings page's Task 2 `TODO` replaced with a real "View or edit the
  head-to-head schedule →" link, shown once a schedule exists. `tools.ts`'s Edit
  Head-to-Head Schedule row now has its `href`.
- Verified: `npx next typegen` (new route, same as Task 8's Draft Recap) → `npx tsc
  --noEmit` → `npm run build`, all clean. New `scripts/lm-schedule-edit-check.ts` against a
  disposable 4-team "LM Tools Task 11 (delete me)" league (schedule generated for next
  Monday): swapping week 2's pairings replaces the `Matchup` rows (new ids, not updated in
  place) while every team still has real history via other weeks; a submission with the
  same team in two pairs is rejected and leaves the week untouched; backdating week 1's
  `startDate` into the past and then trying to edit it is rejected with the exact "This
  week has started." message; editing the championship (playoff) period is rejected with
  the exact "Bracket rounds are filled from standings." message; `getStandings` shows every
  team still at 0-0-0 after all the edits, since every touched period is still in the
  future; `getLeagueSchedule`'s `editable` flag agrees exactly (true for week 2, false for
  backdated week 1 and the championship). A second, distinctly-named 3-team league
  ("LM Tools Task 11 Bye (delete me)") confirmed a team left out of a submitted pairs array
  ends up in zero matchups that week — a real bye, not an error. Both leagues deleted by
  exact name + id. Re-ran `scripts/playoffs-check.ts` and `scripts/scoreboard-check.ts`
  unmodified — both still pass, confirming the new `getUserDisplayName` import into
  `standings.ts` and the reused `getTeamScoreForPeriod` signature introduced no regression.
  Real browser check (`// TEMP:` bypass across `leagues/[id]/layout.tsx`,
  `leagues/[id]/schedule/page.tsx`, `leagues/[id]/schedule/actions.ts`, and, to confirm the
  Scoreboard cross-check, `leagues/[id]/scoreboard/page.tsx`; reverted, `grep -rn "TEMP:"
  src/` clean) against a disposable "LM Tools Task 11 Browser Check (delete me)" league (4
  teams, one week backdated to yesterday to get a real past week to test against): all
  weeks rendered with real (fallback) manager names; the backdated week and the
  not-yet-seeded championship both correctly showed no Edit button while the two untouched
  future weeks did; Edit → swap → Save on week 2 replaced the table's pairing immediately,
  and the Scoreboard page for the same week showed the identical new pairing; switching the
  `// TEMP:` userId to a non-commissioner teammate showed no Edit buttons anywhere (and no
  "LM Tools" nav link) while the read-only table still rendered normally. Disposable league
  deleted by exact name + id afterward.

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
