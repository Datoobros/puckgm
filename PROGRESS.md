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
- Team roster page: skaters table, goalies table below (separate column sets, not padded
  with dashes), Farm section (always empty right now — see above).

## Recent, worth knowing

- `getPlayerStatsAggregate` (`src/lib/players/rankings.ts`) now takes a `scoringConfig`
  param. League players page and team roster page both pass their league's own
  `settings.scoringConfig`. Numbers are identical to before *today* because every league
  is currently seeded with `STARTER_SCORING` at creation — but the wiring is real now, not
  just modeled. This is the first point where per-league scoring customization (DESIGN.md
  §2.4/§2.10) would actually show up if a league changed its config. No UI exists yet to
  *change* a league's scoring config after creation.

## Known gaps, deliberately not built (ask before building)

- No lineups (`LineupEntry` model exists, unused) — no daily "who's starting" concept
- No matchups/scoring-against-an-opponent/standings — league home has no scores to show
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
