# Plan — Player profile modal batch (Sept 2026)

Clicking a player's name **anywhere in a league** opens an ESPN-style profile modal, laid
out like ESPN's player card (the user supplied screenshots — the layout below is a
faithful mapping of them, minus what puckgm has no data for): a **header card** (large
headshot with the NHL team logo, sweater number, name, NHL team, ELIG / MANAGER / STATUS
rows, and POSITION RANK / AVERAGE POINTS on the right), an **action card** (one big
full-width button — DROP / ADD / CLAIM / BID / PROPOSE TRADE), a **Stats card** with two
rows (this season, last season), a **Game Log card** (5 rows + Show More, with OPP and
TOI), and an **All Transactions card** grouped by timestamp with bold verbs and the full
detail of any trade. The modal is a tall centred column that scrolls, with a close ✕
above it and ‹ › arrows to step to the previous/next player in the list it was opened
from. Five tasks, in order, one commit each. **All decisions below are confirmed with the
user — don't re-ask.** Same working rules as the previous plans (`PROGRESS.md` first;
`npx tsc --noEmit` → `npm run build` → real browser verification via `preview_start
{name: "puckgm-dev"}`; exact-name test-data cleanup on the shared prod database;
`// TEMP:` auth bypasses reverted before commit and `grep -rn "TEMP:" src/` clean; commit
messages explain *why*).

**Kickoff prompt for an implementing session:**
> Read `PROGRESS.md`, then `plans/player-modal-batch.md`. Implement **Task N** only,
> exactly as specified — the design decisions are already made. Verify per the task's
> Verification section, add a short section to PROGRESS.md, tick the task's checklist in
> the plan, commit (don't push).

## The target (ESPN's player card, mapped to puckgm)

```
┌──────────────────────────────────────────────────────────────────┐   ✕ (above the card, right)
│ [logo]                 #8  Zach                  POSITION RANK    │
│ [ big headshot ]           Werenski              #4 of 212 D      │
│                            Columbus Blue Jackets                  │
│                            ELIG     D            AVERAGE POINTS   │
│                            MANAGER  QDDD         4.3              │
│                            STATUS   Healthy ●                     │
├──────────────────────────────────────────────────────────────────┤
│              [        DROP        ]   (one button, or a note)     │
└──────────────────────────────────────────────────────────────────┘
┌ Stats ───────────────────────────────────────────────────────────┐
│                 GP   ATOI   G   A   +/-   PIM   SOG  HIT  BLK  FPTS│
│ 2026-27 Season   0     —    —   —    —     —     —    —    —    — │
│ 2025-26 Season  75  26:36  22  59   +7    18   260   …    …  325.5│
└──────────────────────────────────────────────────────────────────┘
┌ Game Log ────────────────────────────────────────────────────────┐
│ DATE  OPP    TOI    G  A  +/-  PIM  SOG  HIT  BLK  FPTS           │
│ 4/14  WSH   25:59   0  0  -1    0    3    …    …   2.2            │
│ 4/12  @MON  30:27   …                                             │  (5 rows)
│                        Show More                                  │
└──────────────────────────────────────────────────────────────────┘
┌ All Transactions ────────────────────────────────────────────────┐
│ FRI, SEP 18, 11:43 AM                                             │
│ **Traded** from Finnland to QAIYAMS…                              │
│ Finnland traded **Zach Werenski**, CBJ D to QAIYAMS…              │
│ Finnland traded **Wyatt Johnston**, DAL C to QAIYAMS…             │
│ QAIYAMS… traded **Leon Draisaitl**, EDM C to Finnland             │
│ TUE, SEP 8, 9:20 PM                                               │
│ **Drafted** 8th overall (1st Rd) by Finnland                      │
└──────────────────────────────────────────────────────────────────┘
        ‹ S. Gostisbehere                        C. Makar ›
```

ESPN things **not** mapped, because puckgm has no data or feature for them (say so in
PROGRESS.md, don't fake them): "% ROSTERED" (user said forget it), "Consider trade
offers?" (no such setting exists), projected stats (rows are last season / this season
instead), "Outlook"/news, "Complete Stats" link, height/weight.

## What exists already (verified 2026-09-20 — don't rediscover)

- `src/components/Modal.tsx` — native `<dialog>` modal, Esc/backdrop close, `max-w-lg`,
  with a bordered title bar. Its header comment already says the player-profile modal
  is expected to reuse it. Four current users: `NotificationsButton`,
  `AdjustScoringModal`, `AcceptTradeControls`, `TradeBuilder`. Native `showModal()`
  stacks, so opening the profile from inside one of those modals works.
- `src/lib/players/rankings.ts` — `getPlayerStatsAggregate({ playerIds?, limit?,
  dateRange?, scoringConfig? })` (one GROUP BY query, returns `PlayerStatsRow` with
  `points`), `getPlayerDailyStats` (per-line extraction with `num(k)` + `decision ===
  "W"`), `searchPlayersByName`.
- `src/lib/players/columns.ts` — `SKATER_COLUMNS` (GP G A SOG HIT BLK PIM +/-),
  `GOALIE_COLUMNS` (GP W SV SO GA), `POINTS_COLUMNS` (TOT, AVG). Reuse for both the
  stats card and the game log; ATOI/TOI are the only additions.
- `src/lib/players/seasons.ts` — `STAT_RANGES` with season entries `2025` ("2025-26",
  Aug 1 2025 → Jul 31 2026) and `2026` ("2026-27", Aug 1 2026 → Jul 31 2027), plus
  `last7`/`last30`. Today (Sept 2026) falls in `2026`, which has no games yet — "this
  season" is therefore an all-zero row until October, and that's what the user wants
  ("even if nothing has happened yet").
- `Player.primaryPosition` is NHL's positionCode: `"C" | "L" | "R" | "D" | "G"`.
- Bio data on `Player`: `dob`, `shoots`, `currentNhlOrg`, `careerNhlGp`,
  `officialRosterStatus` (`ACTIVE | IR | LTIR`, ESPN injury sync), `headshotUrl`, and for
  rookie-draft-class prospects `draftYear / draftRound / draftOverallPick /
  amateurLeague / amateurClubName` (no stat lines, by design). **No** sweater number or
  team full name on `Player` — but every stored `GameStatLine.statsJson` carries
  `sweaterNumber` (raw NHL box-score payload, verified on game `2025020500`), so the
  most recent line gives the number with no schema change. NHL team logos are at
  `https://assets.nhle.com/logos/nhl/svg/{ABBREV}_light.svg` (verified 200,
  `image/svg+xml`, for CBJ; this is the same URL the NHL landing endpoint's `teamLogo`
  field returns). Team full names need a static 32-entry map (there's only
  `NHL_TEAM_ABBREVS` in `src/lib/nhl/client.ts`).
- Per-game `statsJson` keys — skaters: `sweaterNumber, position, goals, assists, points,
  plusMinus, pim, hits, powerPlayGoals, sog, faceoffWinningPctg, toi ("25:59"),
  blockedShots, shifts, giveaways, takeaways`; goalies: `…, saveShotsAgainst, savePctg,
  goalsAgainst, toi, starter, decision, shotsAgainst, saves`.
- `TransactionLog.payload` carries `playerId` for every type **except `TRADE`** (which
  stores `tradeId` + `event`). Full list, from grepping every `transactionLog.create`:
  `ROSTER_ADD {playerId, slotType, commissionerOverride?}`,
  `ROSTER_DROP {playerId, reason?: "MADE_ROOM_FOR_ADD", commissionerOverride?}`,
  `CALLUP {playerId}`, `SEND_DOWN {playerId, waiverExposed}`,
  `IR_MOVE {playerId, direction: "TO_IR"|"FROM_IR"}`,
  `COMMISSIONER_MOVE {playerId, fromSlotType, toSlotType}`,
  `WAIVER_CLAIM {playerId, event: "SUBMITTED"} | {playerId, event: "AWARDED", fromTeamId}`,
  `FAAB_BID {playerId, amount, targetSlot, event: "SUBMITTED"}`,
  `FAAB_WIN {playerId, amount, targetSlot}`,
  `DRAFT_PICK {playerId, round, overallPick, autopicked, slotType, ...}`,
  `LINEUP_EDIT {playerId, date, slot} | {event: "SWAP", ...}`,
  `TRADE {tradeId, event: PROPOSED|ACCEPTED|DECLINED|CANCELLED|VETOED|SUPERSEDED|
  INVALIDATED|AUTO_CANCELLED|PROCESSED|FORCED, commissionerOverride?}`,
  `COMMISSIONER_RESET {draftId, ...}` (no playerId). `actorTeamId` is the acting team.
- `TradeItem` has `itemType PLAYER|PICK|FAAB`, `playerId`, `draftPickId`, `faabAmount`,
  `fromTeamId`, `toTeamId`, `tradeId`; `Trade.state === "PROCESSED"` (+
  `commissionerExecuted`) identifies a completed trade. `DraftPick` has `season, round,
  originalTeamId, overallPick`.
- `src/lib/activity/feed.ts` (`getRecentActivity`) is the existing display reader of
  `TransactionLog` — resolve team/player names in one batch, then build sentences.
- Ownership/availability reads: `getLeagueOwnershipMap` (`src/lib/rosters/ownership.ts`),
  `getClaimablePlayers(leagueId, viewingTeamId)` (`src/lib/waivers/mutations.ts`),
  `getFreeAgencyStatus(leagueId)` (`src/lib/draft/mutations.ts`), `getAvailableBudget` /
  `getMyPendingBids` (`src/lib/faab/mutations.ts`), `activeRosterCap(settings)`.
- Existing Server Actions the modal's button will call (all `"use server"` +
  `auth.protect()`): `addPlayerAction(leagueId, teamId, playerId, dropPlayerId?)`,
  `submitFaBidAction(leagueId, playerId, formData)`, `cancelFaBidAction(leagueId,
  bidId)`, `toggleWatchlistAction(leagueId, playerId)`, `searchPlayersAction` (the
  precedent for a **read** via Server Action) in `src/app/leagues/[id]/players/actions.ts`;
  `dropPlayerAction(leagueId, teamId, playerId)` in `teams/[teamId]/actions.ts`;
  `submitWaiverClaimAction(leagueId, playerId)` / `cancelWaiverClaimAction(leagueId,
  claimId)` in `waivers/actions.ts`.
- `AddPlayerCell` (bottom of `players/PlayerStatsTable.tsx`, not exported) already
  implements Add + the "roster full — drop who?" picker. Task 4 extracts it.
- `src/components/*` importing actions from `@/app/leagues/actions` is established
  (`DeleteLeagueButton.tsx` etc.).
- `/leagues/[id]/trades/new?with=<teamId>` preselects the trade partner (verified:
  `first("with")` in `trades/new/page.tsx`).
- `src/lib/ingest/games.ts`'s `ingestGame` iterates
  `[box.playerByGameStats?.awayTeam, box.playerByGameStats?.homeTeam]` and upserts each
  line as `{ playerId, gameId, gameDate, statsJson }` — it never records which team the
  line was for. The live boxscore does carry it, verified against game `2025020500`:
  top-level `awayTeam: { id: 8, abbrev: "MTL", score: 4 }`, `homeTeam: { id: 3, abbrev:
  "NYR", score: 5 }`, `gameOutcome: { lastPeriodType: "REG" | "OT" | "SO" }`.
  `NhlBoxscore` in `client.ts` just doesn't declare those fields yet.
- `scripts/backfill-season.ts` re-ingests every final regular-season game with
  `runWithConcurrency(…, 10, …)`; `ingestGame` is an upsert, so re-running it over
  existing games is how the new columns get backfilled.
- Prisma migrations live in `prisma/migrations/` (`npx prisma migrate dev --name …`).
  Dev and prod share one Neon database — adding **nullable** columns is safe.
- All player-name render sites (`grep -rln 'fullName' src/app src/components`):
  `players/PlayerStatsTable.tsx`, `players/PlayerSearchBox.tsx`,
  `teams/[teamId]/RosterMoveBoard.tsx` (two places), `teams/rosters/page.tsx`,
  `matchups/[matchupId]/page.tsx`, `scoreboard/page.tsx` (short name), `trades/
  TradeBuilder.tsx` (two), `trades/TradeRosterTable.tsx`, `trades/TradeAssetSummary.tsx`,
  `draft/DraftRoom.tsx`, `draft/recap/DraftRecapBoard.tsx`, `settings/roster-moves/
  {AddPlayerStep,DropPlayerStep,EditLineupForm,ManageFarmStep,ManageIrStep}.tsx`. All
  inside `src/app/leagues/[id]/layout.tsx`, so one provider there covers every site.
  No row-level `onClick` at any of them (the draft-room Draft button, trade-table
  checkbox and roster-board Move button are separate controls), but `PlayerName` still
  calls `stopPropagation()`.

## Decisions already made (don't re-open)

- **Click sites: every place a player name appears** inside a league, via one shared
  `PlayerName` client component. Deliberate exceptions: the Players-page typeahead
  (`PlayerSearchBox.tsx`) and prose feeds (notifications, activity feed).
- **One modal instance per league**, mounted by `PlayerProfileProvider` in
  `src/app/leagues/[id]/layout.tsx`; rendered **only while a player is open**. Data
  loads via `getPlayerProfileAction` on open and after any successful action.
- **Modal chrome = ESPN's**: a tall centred column (`max-w-3xl`) of stacked cards on the
  dark backdrop, **the column scrolls** (`max-h-[92vh] overflow-y-auto`), a white ✕
  sticky at the top-right, and ‹ › arrows with the neighbouring players' short names
  (`S. Gostisbehere`, `C. Makar`) sticky at mid-height on each side when the modal was
  opened from a list. Esc / backdrop click / ✕ close; ← → keys step to prev/next.
- **Prev/next comes from a `PlayerNavList` context**, not from props on every name: a
  list-rendering component wraps its rows in `<PlayerNavList players={[{id, fullName},
  …]}>` and `PlayerName` reads the nearest one. Sites without a wrapper open the modal
  with no arrows. The order is the list's **rendered** order (after sort/filter/paging on
  the Players page — pass the current `pageRows`, not all rows).
- **Header card**: big headshot (`PlayerHeadshot size={120}`) with the NHL team logo
  (`https://assets.nhle.com/logos/nhl/svg/{currentNhlOrg}_light.svg`, `onError` → hide)
  overlaid top-left; `#{sweaterNumber}` from the most recent stat line (omitted when no
  lines); first name light / last name bold (split on the last space); NHL team full name
  from a new static `NHL_TEAM_NAMES` map (fallback: the abbrev); rows **ELIG** =
  position label (`C`/`LW`/`RW`/`D`/`G`), **MANAGER** = owning fantasy team name, or
  `Free Agent`, or `Waivers (from {team})`, **STATUS** = `Healthy ●` green /
  `IR ●` red / `LTIR ●` red from `officialRosterStatus` (null counts as Healthy — the
  ESPN sync only writes non-null for listed players). Right column: **POSITION RANK**
  and **AVERAGE POINTS**, both for **this season** (`--` when 0 games — exactly what
  ESPN shows pre-season). Prospects get a fourth row **DRAFT** with the pedigree
  ("2026 · Rd 1, #4 · Erie Otters (OHL)"). Watchlist ☆/★ top-right of the header, only
  when the viewer has a team.
- **Position rank honours the league's `positionMode`.** Group = `["G"]`, `["D"]`, or
  for forwards `["C"] / ["L"] / ["R"]` in `SEPARATE` mode (label `C`/`LW`/`RW`) and
  `["C","L","R"]` in `COMBINED` mode (label `F`). Computed among group players **with
  ≥ 1 game this season**, as `1 + (count with strictly more points)` — ties share a
  rank; shown `#12 of 287 C`.
- **Stats card: exactly two rows, no dropdown** — `{thisSeason.label} Season` on top,
  `{lastSeason.label} Season` below (this = the `STAT_RANGES` season entry containing
  today; last = the entry before it; add a `currentAndLastSeason()` helper to
  `seasons.ts` rather than hardcoding `2026`/`2025`). Columns: GP · **ATOI** · the
  position's `SKATER_COLUMNS`/`GOALIE_COLUMNS` minus GP · **FPTS** (= `POINTS_COLUMNS`'
  TOT). A row with GP 0 shows `0` for GP and `—` in every other cell. Points use **the
  league's own `scoringConfig`**. `AVG` (points/GP) is in the header, not the table.
- **Game log: the 25 most recent games overall** (not season-scoped — ESPN shows last
  April's games in September), 5 visible, **Show More** reveals the rest client-side.
  Columns: DATE (`M/D`) · **OPP** (`WSH` / `@MON`, with the result `W 5-4 (OT)` as the
  cell's `title` tooltip) · **TOI** · position stat columns minus GP · FPTS. OPP/TOI/
  result come from Task 1's columns and `statsJson.toi`; rows whose context is still
  null render `—` in OPP.
- **All Transactions = this league's completed ownership/tier history**, newest first,
  capped at 50 events, grouped under a timestamp header (`FRI, SEP 18, 11:43 AM`, the
  viewer's local time), bold verb first. **Trade offers are confidential**: only
  `Trade.state === "PROCESSED"` trades appear, never PROPOSED / UNDER_REVIEW / DECLINED
  / CANCELLED / VETOED / SUPERSEDED / INVALIDATED / AUTO_CANCELLED rows. A trade renders
  the headline `**Traded** from A to B` plus one line per item in that trade (all of
  them, not just this player): `A traded **Player**, CBJ D to B`, `A traded **2027 Rd 1
  pick (orig. Team X)** to B`, `A traded **$20 FAAB** to B`. Other verbs: `**Drafted**
  8th overall (1st Rd) by X`, `**Added** by X` (+ ` to farm`, + ` (commissioner)`),
  `**Dropped** by X` (+ ` to make room`, + ` (commissioner)`), `**Claimed** off waivers
  by X from Y`, `**Won** on the wire by X for $N`, `**Called up** to active by X`,
  `**Sent down** to farm by X` (+ ` — exposed to waivers`), `**Placed on IR** by X`,
  `**Activated** from IR by X`, `**Moved** ACTIVE → FARM by commissioner`. Excluded:
  lineup edits, `FAAB_BID`, `WAIVER_CLAIM` with `event !== "AWARDED"`,
  `COMMISSIONER_RESET`.
- **Action card (Task 4)** — one full-width pill button (ESPN's DROP), branch chosen by
  the viewer's team and the player's league status, in this priority order:
  1. viewer has no team in this league → no action card;
  2. viewer's team is `ORPHAN_FROZEN` → muted "Your team is orphaned — its roster is
     frozen." (mutations already refuse; avoid dead buttons);
  3. on the viewer's team → **DROP** (danger; click swaps the button for an inline
     `Drop {name}? [Confirm drop] [Cancel]` — not `confirm()`, the browser harness can't
     click native dialogs);
  4. on waivers from another team → **CLAIM**, or `Claim pending` + **CANCEL CLAIM**;
  5. on another team → **PROPOSE TRADE** → `/leagues/[id]/trades/new?with=<teamId>`;
  6. free agent, free agency closed → muted "Free agency is closed until the draft is
     complete.";
  7. free agent, FAAB league → amount + Active/Farm + **BID**, or `Bid pending: $N →
     Active` + **CANCEL BID**;
  8. free agent, non-FAAB → **ADD**, or the roster-full drop picker (the extracted
     `AddPlayerCell`).
  No farm/IR controls — the team page's board owns those. After success: re-fetch the
  profile **and** `router.refresh()`; the modal stays open.
- **Prospects with no stat lines** show the DRAFT header row and honest empty states
  ("No NHL games ingested.") in Stats/Game Log — never zeros pretending to be stats.
- **Modal component**: add `size?: "md" | "xl"` and `bare?: boolean` to `Modal`
  (`bare` = no title bar, transparent dialog background, children own the cards and the
  scroll; default `false` so the four existing users are untouched).
- **Not built**: % rostered, "Consider trade offers?", projections, news/outlook,
  career table, height/weight. Dropping a player whose game already started still
  forfeits that day's points — pre-existing documented gap, unchanged.

---

## Task 1 — Game context on `GameStatLine` + backfill

Independent of the UI and the longest-running step (a real backfill over ~1,312 games
against the production database), so it goes first.

### Changes
1. **`prisma/schema.prisma`**, `GameStatLine` — six new **nullable** columns, with a
   comment saying rows older than this migration are backfilled by
   `scripts/backfill-game-context.ts` and the game log renders `—` for any row still
   missing them:
   ```prisma
   teamAbbrev     String?
   opponentAbbrev String?
   isHome         Boolean?
   teamScore      Int?
   opponentScore  Int?
   lastPeriodType String? // "REG" | "OT" | "SO" — gameOutcome.lastPeriodType
   ```
   `npx prisma migrate dev --name add_game_stat_line_context`. Nullable only — shared
   dev/prod database.
2. **`src/lib/nhl/client.ts`**, `NhlBoxscore` — declare what the API already returns:
   `awayTeam: { id: number; abbrev: string; score?: number }`, `homeTeam: same`,
   `gameOutcome?: { lastPeriodType?: string }`.
3. **`src/lib/ingest/games.ts`**, `ingestGame` — iterate the two sides with side
   knowledge instead of the anonymous two-element array:
   ```ts
   for (const side of ["awayTeam", "homeTeam"] as const) {
     const other = side === "awayTeam" ? "homeTeam" : "awayTeam";
     const context = {
       teamAbbrev: box[side].abbrev,
       opponentAbbrev: box[other].abbrev,
       isHome: side === "homeTeam",
       teamScore: box[side].score ?? null,
       opponentScore: box[other].score ?? null,
       lastPeriodType: box.gameOutcome?.lastPeriodType ?? null,
     };
     for (const p of teamPlayers(box.playerByGameStats?.[side])) { … }
   }
   ```
   Spread `context` into **both** the `create` and `update` branches of the upsert.
   `statsJson` stays exactly as it is — the context lives in real columns.
4. **`scripts/backfill-game-context.ts`** (new) — resumable, idempotent:
   `SELECT DISTINCT "gameId" FROM "GameStatLine" WHERE "opponentAbbrev" IS NULL`, then
   `ingestGame(Number(gameId))` over that list with `runWithConcurrency(ids, 10, …)`
   (copy the progress/error reporting from `backfill-season.ts`; **don't** call
   `syncAllRosters`). Print the null count before and after. End with assertions that
   exit non-zero on failure: (a) zero rows with `opponentAbbrev IS NULL`; (b) spot check:
   every line for `gameId = "2025020500"` with `teamAbbrev = "MTL"` has `opponentAbbrev =
   "NYR"`, `isHome = false`, `teamScore = 4`, `opponentScore = 5`, `lastPeriodType =
   "REG"`, and the NYR lines are the mirror image. Usage comment at the top:
   `npx tsx --env-file=.env scripts/backfill-game-context.ts`.
5. **Run it** for real. Expect roughly the original season backfill's wall time. If it
   dies partway, re-run — it only picks up rows still null.
6. No UI change. The daily cron (`api/cron/daily-ingest` → `ingestDate` → `ingestGame`)
   picks the context up automatically from now on.

### Verification
- `npx tsc --noEmit` and `npm run build` clean.
- The backfill script's own final assertions pass (paste the before/after null counts
  and the spot-check output into PROGRESS.md).
- Re-run `scripts/score-check.ts` (or whichever existing script asserts fantasy points
  against NHL season totals — check `scripts/` and PROGRESS.md's scoring section) to
  prove the re-ingest changed no `statsJson` and therefore no points.
- `SELECT COUNT(*) FROM "GameStatLine"` is the same before and after (upsert, not insert).

### Checklist
- [ ] schema + migration; `NhlBoxscore` fields; `ingestGame` writes context on create and update
- [ ] `scripts/backfill-game-context.ts` written and **run to completion** against the real DB
- [ ] verified (assertions, score check, row count unchanged); PROGRESS.md; committed

---

## Task 2 — Profile data layer + Server Action

Everything the modal shows, in one server-side function, with a script proving it.

### Changes
1. **`src/lib/players/seasons.ts`** — `export function currentAndLastSeason(today =
   todayUTC()): { thisSeason: SeasonRange; lastSeason: SeasonRange | null }` where
   `SeasonRange = { value, label, start, end }`: `thisSeason` = the `kind: "season"`
   entry whose `[start, end]` contains today (fall back to the latest season entry if
   none contains it — e.g. if `STAT_RANGES` hasn't been extended yet), `lastSeason` =
   the season entry immediately before it in `STAT_RANGES`, or null. Today → `2026` /
   `2025`. `today` injectable like `resolveStatRange` for the check script.
2. **`src/lib/nhl/client.ts`** — `export const NHL_TEAM_NAMES: Record<string, string>`
   (32 entries, `CBJ → "Columbus Blue Jackets"`, `UTA → "Utah Mammoth"`, etc. — cover
   every abbrev in `NHL_TEAM_ABBREVS`; add a one-line test in the check script that
   every abbrev has a name) and `export function nhlTeamLogoUrl(abbrev: string)` →
   `https://assets.nhle.com/logos/nhl/svg/${abbrev}_light.svg`.
3. **`src/lib/players/rankings.ts`**
   - `getPlayerStatsAggregate`: add `positions?: string[]` to `opts` → `AND
     p."primaryPosition" IN (…)`. The current `whereClause` is either `WHERE p.id IN (…)`
     or `Prisma.empty`; rewrite as a list of `Prisma.sql` conditions joined with `AND`
     (prefixed with `WHERE` only if non-empty) so `playerIds` and `positions` compose.
     Existing callers pass neither → identical SQL.
   - Extract the per-line mapping inside `getPlayerDailyStats` (the `num(k)` /
     `decision === "W"` block) into an exported `statLineToRow(line, player,
     scoringConfig): PlayerStatsRow` and call it from `getPlayerDailyStats`.
4. **`src/lib/players/profile.ts`** (new) — `getPlayerProfile(input: { leagueId;
   playerId; viewerUserId }): Promise<PlayerProfile>`. Throws `"League not found."` /
   `"Player not found."`. All dates as ISO strings. Shape:
   ```ts
   export interface PlayerProfile {
     player: {
       id: string; firstName: string; lastName: string; fullName: string;
       sweaterNumber: number | null;
       primaryPosition: string | null; positionLabel: string;     // C / LW / RW / D / G / "—"
       isGoalie: boolean;
       currentNhlOrg: string | null; nhlTeamName: string | null; nhlTeamLogoUrl: string | null;
       headshotUrl: string | null;
       healthStatus: "Healthy" | "IR" | "LTIR";
       draftPedigree: string | null;     // "2026 · Rd 1, #4 · Erie Otters (OHL)" — null unless draftYear set
     };
     rank: { position: number; groupSize: number; groupLabel: string } | null;   // this season
     averagePoints: number | null;                                                // this season, null when 0 GP
     seasons: SeasonStatsRow[];          // [thisSeason, lastSeason?] in that order
     gameLog: GameLogRow[];              // up to 25, newest first
     transactions: TransactionEvent[];   // up to 50 events, newest first
     status: PlayerLeagueStatus;
     watching: boolean;
   }
   export interface SeasonStatsRow { label: string; stats: PlayerStatsRow; atoi: string | null }  // "26:36"
   export interface GameLogRow {
     gameId: string; date: string;               // "YYYY-MM-DD"
     opponent: string | null;                    // "WSH" | "@MON" | null
     result: string | null;                      // "W 5-4" | "L 4-5 (OT)" | "L 2-3 (SO)" | null
     toi: string | null;                         // statsJson.toi as stored
     stats: PlayerStatsRow;                      // gamesIngested = 1, points = that game's FPTS
   }
   export interface TransactionEvent {
     id: string; at: string;
     kind: "DRAFT"|"ADD"|"DROP"|"WAIVER"|"FAAB"|"TRADE"|"CALLUP"|"SEND_DOWN"|"IR"|"COMMISSIONER";
     verb: string;                               // "Traded", "Drafted", "Added", …  (rendered bold)
     headline: string;                           // the rest of the first line: "from Finnland to QAIY…"
     details: TransactionDetailLine[];           // trades only — one per TradeItem; empty otherwise
   }
   export interface TransactionDetailLine { fromTeam: string; toTeam: string; asset: string; assetSuffix: string }
   // renders as `{fromTeam} traded **{asset}**{assetSuffix} to {toTeam}` — e.g. asset "Zach Werenski", suffix ", CBJ D";
   // asset "2027 Rd 1 pick (orig. Finnland)", suffix ""; asset "$20 FAAB", suffix ""
   export interface PlayerLeagueStatus {
     viewerTeamId: string | null; viewerTeamFrozen: boolean;
     onMyTeam: { slotType: "ACTIVE" | "FARM" | "IR" } | null;
     ownedBy: { teamId: string; teamName: string; slotType: "ACTIVE" | "FARM" | "IR" } | null;   // any open slot (includes viewer's own team)
     waivers: { expiresAt: string; demotingTeamId: string; demotingTeamName: string; myPendingClaimId: string | null } | null;
     freeAgencyOpen: boolean;
     faab: { minBid: number; maxBid: number | null; myPendingBid: { id: string; amount: number; targetSlot: string } | null } | null;  // null when FAAB off or no viewer team
     activeCount: number; activeCap: number;
     activeRosterPlayers: { id: string; fullName: string }[];
   }
   ```
   Implementation notes, in order:
   - `getLeague(leagueId)` → `settings`; `myTeam = league.teams.find(t =>
     isTeamManager(t, viewerUserId)) ?? null`; `player = prisma.player.findUnique`.
   - `const { thisSeason, lastSeason } = currentAndLastSeason()`.
   - **Player lines**: `prisma.gameStatLine.findMany({ where: { playerId }, orderBy:
     { gameDate: "desc" } })` — one query, ≤ a few hundred rows for anyone. From it:
     `sweaterNumber` = `Number(lines[0]?.statsJson.sweaterNumber)` or null; `gameLog` =
     first 25 mapped with `statLineToRow` (+ `toi = statsJson.toi ?? null`, `opponent =
     opponentAbbrev ? (isHome ? opp : \`@${opp}\`) : null`, `result` = null unless both
     scores set, else `W`/`L` by comparing scores, `${teamScore}-${opponentScore}`,
     suffix ` (OT)` / ` (SO)` by `lastPeriodType`; `date = gameDate.toISOString().slice(0,
     10)`); **ATOI per season** = lines in that season's range → parse `toi` `"mm:ss"` to
     seconds, mean, format back `m:ss`; null when no lines or no parsable `toi`.
   - **Season totals**: `getPlayerStatsAggregate({ playerIds: [playerId], dateRange:
     season, scoringConfig: settings.scoringConfig })[0]` for each of the (one or two)
     seasons — keeps the points arithmetic in the one verified place. `label =
     \`${season.label} Season\``.
   - **Rank / average**: group per the decision above; `getPlayerStatsAggregate({
     positions: group, dateRange: thisSeason, scoringConfig })`, filter `gamesIngested >
     0`; player not in the filtered list → `rank = null`, `averagePoints = null`; else
     `position = 1 + count(points > mine)`, `groupSize = filtered.length`,
     `averagePoints = mine.points / mine.gamesIngested`.
   - **Transactions**, two sources merged, sorted by `at` desc, `slice(0, 50)`:
     1. `prisma.transactionLog.findMany({ where: { leagueId, payload: { path:
        ["playerId"], equals: playerId } }, orderBy: { createdAt: "desc" }, take: 100 })`
        (Prisma JSON path filter, Postgres). Drop `LINEUP_EDIT`, `FAAB_BID`,
        `WAIVER_CLAIM` with `event !== "AWARDED"`. Team names via one
        `prisma.team.findMany` over every `actorTeamId` / `fromTeamId` seen (`"A team"`
        fallback). Verb/headline per the decision list; `"8th overall (1st Rd)"` needs a
        tiny ordinal helper (`1st 2nd 3rd 4th … 11th 12th 13th … 21st`).
     2. `prisma.tradeItem.findMany({ where: { playerId, trade: { leagueId, state:
        "PROCESSED" } }, select: { tradeId: true } })` → distinct trade ids → for each,
        `prisma.trade.findUnique({ include: { items: { include: { player: true,
        draftPick: { include: { originalTeam: true } }, fromTeam: true, toTeam: true } } }
        })`. Headline `from {fromTeam} to {toTeam}` uses **this player's** item;
        `details` = every item: PLAYER → asset `fullName`, suffix `, {currentNhlOrg}
        {positionLabel}`; PICK → asset `{season} Rd {round} pick (orig. {originalTeam.name})`;
        FAAB → asset `${faabAmount} FAAB`. `+ " (commissioner)"` on the headline when
        `commissionerExecuted`. Timestamp: the league's `TRADE` log rows with `event` in
        `PROCESSED|FORCED` (one `findMany({ where: { leagueId, type: "TRADE" } })`, match
        `payload.tradeId` in JS like the activity feed), falling back to
        `trade.respondedAt ?? trade.proposedAt`.
   - **Status**: `ownedBy` from `prisma.rosterSlot.findFirst({ where: { playerId,
     effectiveTo: null, team: { leagueId } }, include: { team: true } })`; `onMyTeam` =
     that slot when `slot.teamId === myTeam?.id`; `waivers` = that slot when `slotType
     === "FARM" && waiverExpiresAt > now && teamId !== myTeam?.id`, `myPendingClaimId`
     from `prisma.waiverClaim.findFirst({ where: { teamId: myTeam.id, playerId, result:
     "PENDING" } })`; `freeAgencyOpen` from `getFreeAgencyStatus(leagueId).open`; `faab`
     only when `settings.faabEnabled && myTeam` (`myPendingBid` from
     `getMyPendingBids(leagueId, myTeam.id).find(b => b.playerId === playerId)`);
     `activeCount` / `activeRosterPlayers` from the viewer's open ACTIVE slots (same
     query the Players page runs), `activeCap = activeRosterCap(settings)`;
     `viewerTeamFrozen = myTeam?.state === "ORPHAN_FROZEN"`.
   - `watching` = `getWatchlistedPlayerIds(leagueId, viewerUserId).has(playerId)`.
   - Header helpers: `firstName`/`lastName` split on the **last** space (`"Jean-Gabriel
     Pageau"` → `Jean-Gabriel` / `Pageau`; a single-token name → `firstName: ""`);
     `positionLabel` map `{C:"C", L:"LW", R:"RW", D:"D", G:"G"}`; `healthStatus` from
     `officialRosterStatus` (`IR`/`LTIR` pass through, anything else → `Healthy`);
     `draftPedigree` only when `draftYear` is set — `${draftYear} · Rd ${draftRound},
     #${draftOverallPick}` + ` · ${amateurClubName} (${amateurLeague})` when set.
5. **`src/app/leagues/[id]/players/actions.ts`** — `export async function
   getPlayerProfileAction(leagueId: string, playerId: string): Promise<PlayerProfile>`
   → `auth.protect()` → `getPlayerProfile({ …, viewerUserId: userId })`. Read-only, no
   `revalidatePath`. A team-less member may view (the Players page already allows it).

### Verification
- **`scripts/player-profile-check.ts`** (new) against a disposable league
  `"Player Modal Check (delete me)"`, two teams, managers `"pmc-A"` / `"pmc-B"`, plus the
  throwaway 1-round STARTUP draft that opens free agency (copy the block from
  `scripts/lm-roster-moves-check.ts` ~lines 36–72). Use a **real** player looked up by
  name (`Connor McDavid`; assert found, never create a stub for him). Asserting after
  each step:
  1. `NHL_TEAM_NAMES` has an entry for every `NHL_TEAM_ABBREVS` value;
     `currentAndLastSeason("2026-09-20")` → `2026` / `2025`;
     `currentAndLastSeason("2026-03-01")` → `2025` / null-or-`2024`-if-present.
  2. Profile as `pmc-A` before any roster move: `player.sweaterNumber === 97`,
     `player.nhlTeamName === "Edmonton Oilers"`, `player.firstName === "Connor"`,
     `healthStatus` is one of the three; `status.ownedBy === null`, `onMyTeam === null`,
     `freeAgencyOpen === true`, `faab === null`; `seasons[0].label` starts with
     `"2026-27"` and has `gamesIngested === 0`, `atoi === null`; `seasons[1]` is
     `"2025-26 Season"` with `gamesIngested > 0`, `points > 0`, `atoi` matching
     `/^\d+:\d\d$/`; `rank === null` and `averagePoints === null` (no 2026-27 games yet
     — **if the season has started by the time this runs, assert the opposite: rank
     non-null with `1 <= position <= groupSize`, `groupLabel === "C"`**); `gameLog.length
     === 25`, every row's `opponent` non-null and matching `/^@?[A-Z]{3}$/`, `toi`
     non-null, `result` matching `/^[WL] \d+-\d+( \((OT|SO)\))?$/`; `transactions.length
     === 0`; `watching === false`.
  3. `addPlayerToRoster` him to team A (as `pmc-A`). Profile as `pmc-A`:
     `onMyTeam.slotType === "ACTIVE"`, `ownedBy.teamId === teamA`, `transactions[0].kind
     === "ADD"`, `verb === "Added"`, `headline === "by {teamA name}"`. Profile as `pmc-B`:
     `onMyTeam === null`, `ownedBy.teamName` is team A's name.
  4. `sendToFarm` from team A (careerNhlGp ≥ 80 → `waiverExposed === true`): profile as
     `pmc-B` has `waivers !== null`, `myPendingClaimId === null`; after
     `submitWaiverClaim` as `pmc-B`, `myPendingClaimId` set; `transactions[0].kind ===
     "SEND_DOWN"` with `"exposed to waivers"` in the headline.
  5. A processed trade: void the claim, call him back up, then build a 2-for-1 trade A→B
     via the trade mutations (look at `scripts/trades-check.ts` for the propose → accept
     → `executeTradeTransfers` sequence; include a draft pick going the other way) →
     `transactions[0].kind === "TRADE"`, `verb === "Traded"`, `headline === "from {A} to
     {B}"`, `details.length === 3` (two players + the pick), the pick line's asset
     matches `/^\d{4} Rd \d pick \(orig\. .+\)$/`. Then propose a **second** trade and
     leave it PROPOSED → `transactions` still has exactly one TRADE event
     (confidentiality).
  6. `toggleWatchlist` as `pmc-B` → `watching === true` for `pmc-B`, `false` for `pmc-A`.
  7. A prospect: any `Player` with `draftYear IS NOT NULL` (skip with a printed note if
     none) → `draftPedigree` non-empty, `sweaterNumber === null`, both seasons
     `gamesIngested === 0`, `rank === null`, `gameLog.length === 0`.
  8. Cleanup by exact league name + id — league, teams, slots, claims, trades, logs,
     watchlist rows; **never** the real `Player` rows.
- `getPlayerDailyStats` unchanged in behaviour: `scripts/scoreboard-check.ts` still
  passes. Existing `getPlayerStatsAggregate` callers unchanged: `scripts/score-check.ts`
  still passes.
- `npx tsc --noEmit`, `npm run build` clean.

### Checklist
- [ ] `currentAndLastSeason`; `NHL_TEAM_NAMES` + `nhlTeamLogoUrl`
- [ ] `positions` filter + `statLineToRow` in rankings.ts (existing callers unchanged)
- [ ] `src/lib/players/profile.ts` — header / rank+avg / two seasons with ATOI / game log / transactions with trade details / status / watching
- [ ] `getPlayerProfileAction`
- [ ] `scripts/player-profile-check.ts` passes; scoreboard-check + score-check still pass; PROGRESS.md; committed

---

## Task 3 — Modal UI, provider, `PlayerName`, prev/next, first wiring (Players page)

Read-only modal plus the watchlist star. No roster actions yet (Task 4).

### Changes
1. **`src/components/Modal.tsx`** — `size?: "md" | "xl"` (`max-w-lg` / `max-w-3xl`,
   default `md`) and `bare?: boolean` (default `false`). When `bare`: the `<dialog>`
   gets `bg-transparent border-0 p-0 max-h-[92vh] overflow-y-auto` and renders
   `{children}` directly — no title bar, no inner `max-h-[70vh]` wrapper (the
   `title` prop becomes the dialog's `aria-label`). Backdrop-click detection stays as
   is (a click on the dialog element itself); note that with a transparent dialog the
   gaps **between** the stacked cards are the dialog element, so a click in a gap
   closes — that's acceptable and matches ESPN.
2. **`src/components/player-profile/PlayerProfileProvider.tsx`** (`"use client"`) —
   context `{ openPlayer(playerId: string, nav?: { players: { id; fullName }[] }) }`;
   props `{ leagueId, children }`; state `{ playerId, nav } | null`; renders
   `{children}` and, only when open, `<PlayerProfileModal leagueId playerId nav
   onNavigate={(id) => set({ playerId: id, nav })} onClose={() => set(null)} />`.
   Export `usePlayerProfile()` (nullable).
3. **`src/components/player-profile/PlayerNavList.tsx`** (`"use client"`) — a context
   holding `{ players: { id; fullName }[] }`; `<PlayerNavList players={…}>` provider +
   `usePlayerNavList()` (nullable).
4. **`src/components/player-profile/PlayerName.tsx`** (`"use client"`) — props `{
   playerId; fullName; className?; children? }`. No profile context → plain `<span>`.
   Otherwise `<button type="button">` with `onClick={(e) => { e.stopPropagation();
   openPlayer(playerId, navList ? { players: navList.players } : undefined); }}`,
   classes `text-left hover:underline focus-visible:underline` + `className`,
   `title={fullName}` when `children` is given.
5. **`src/components/player-profile/PlayerProfileModal.tsx`** (`"use client"`) — props
   `{ leagueId; playerId; nav?; onNavigate; onClose }`. State `profile | null`,
   `loading`, `error`, `showAllGames`. `useEffect` on `[leagueId, playerId]` →
   `getPlayerProfileAction`; expose `reload()`. Keyboard: `←`/`→` call `onNavigate`
   with the neighbour when `nav` has one. Renders `<Modal open bare size="xl"
   title={fullName}>` containing, in a `relative flex flex-col gap-3 py-6` column:
   - a **sticky top bar** (`sticky top-0 z-10 flex justify-end`, transparent) with the
     white ✕ (`Button variant="ghost"`, `aria-label="Close"`) — it stays visible while
     the column scrolls;
   - **‹ / › arrows**: when `nav` yields a previous/next player, two `sticky
     top-1/2` white controls positioned at the column's left/right edges
     (`absolute -left-24` / `-right-24` inside a sticky wrapper; on `md:` and up only —
     on phones they collapse into a small `‹ prev · next ›` row under the header card),
     each showing the neighbour's short name (`S. Gostisbehere` — first initial + last
     name, same rule as `scoreboard/page.tsx`'s `shortPlayerName`; copy the 4-line
     helper, it isn't exported);
   - **Header card** (`Card`): left block `relative` — `PlayerHeadshot size={120}`
     (rounded square, not circle — pass a `className` override or add a `shape` prop to
     `PlayerHeadshot`; keep the silhouette fallback) with the team logo `<img>` (40px,
     `absolute top-2 left-2`, `onError` hides) — plus `#{sweaterNumber}` in large muted
     type; middle block — `firstName` in normal weight and `lastName` bold on the next
     line, `nhlTeamName ?? currentNhlOrg ?? "—"` muted, then a 2-column definition list
     ELIG / MANAGER / STATUS (+ DRAFT for prospects), labels muted uppercase
     `text-xs tracking-wide`, STATUS with a `●` dot `text-success`/`text-danger`; right
     block (bordered-left on `md:`) — POSITION RANK and AVERAGE POINTS as label +
     large value (`#4 of 212 D` / `4.3`, or `--`); watchlist ☆/★ at the card's top-right
     when `status.viewerTeamId`, optimistic like `PlayerStatsTable`'s
     `handleToggleWatch`, then `router.refresh()` so the page's star matches.
   - **Action card placeholder**: Task 4 fills it — in this task render nothing (no
     empty card).
   - **Stats card**: title "Stats"; table in an `overflow-x-auto` wrapper with the two
     season rows per the decision (GP · ATOI · position columns minus GP · FPTS; GP-0
     row → `0` then `—`s). Prospect → "No NHL games ingested."
   - **Game Log card**: DATE · OPP (`title={result}`) · TOI · position columns minus
     GP · FPTS; `gameLog.slice(0, showAllGames ? 25 : 5)`; a centred "Show More" text
     button when more than 5 exist and `!showAllGames`. Empty → "No games yet."
   - **All Transactions card**: for each event, a muted uppercase header bar
     (`bg-surface-tint px-3 py-1 text-xs`) with the timestamp formatted client-side as
     `EEE, MMM D, h:mm A` in the viewer's locale (`toLocaleString` with `{ weekday:
     "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }`,
     upper-cased), then `<strong>{verb}</strong> {headline}`, then each detail line
     `{fromTeam} traded <strong>{asset}</strong>{assetSuffix} to {toTeam}`. Empty → "No
     transactions in this league yet."
   - Loading: "Loading…" in place of the cards on first load; on `onNavigate` keep the
     old cards at `opacity-60` until the new profile arrives (no flash to empty).
     Error: message + "Retry" ghost button.
   - Native form controls / table styling: follow the Players page's table classes and
     PROGRESS.md's "Native form control theming" section.
6. **`src/app/leagues/[id]/layout.tsx`** — wrap `{props.children}` in
   `<PlayerProfileProvider leagueId={id}>`; `LeagueNav` stays outside.
7. **`src/app/leagues/[id]/players/PlayerStatsTable.tsx`** — wrap the `<tbody>`'s rows
   in `<PlayerNavList players={pageRows.map(r => ({ id: r.id, fullName: r.fullName }))}>`
   (rendered order = sorted + paged) and change `{r.fullName}` to `<PlayerName
   playerId={r.id} fullName={r.fullName} />`. Nothing else on the page changes.

### Verification
- `npx tsc --noEmit`, `npm run build` clean.
- Browser (`// TEMP:` bypass in `leagues/[id]/layout.tsx` and `players/actions.ts`'s
  `getPlayerProfileAction`, reverted), the user's real "Experimenting" league,
  **read-only** except the watchlist star (toggle it back): open McDavid from the
  Players page → header (logo, #97, Connor / **McDavid**, Edmonton Oilers, ELIG C,
  MANAGER = whoever owns him there, STATUS), rank/avg show `--` (pre-season) or real
  values (in season), Stats shows the 2026-27 zero row above the 2025-26 row with ATOI,
  Game Log shows 5 rows with `WSH`/`@MON`-style opponents and TOI, Show More expands to
  25, transactions render grouped with bold verbs (Experimenting has real trades — the
  trade shows every asset; confirm no PROPOSED trade appears by checking the Trades
  page). Arrows: ‹ › show the neighbours from the current page of the table, clicking
  › loads the next player without closing, `→` key does the same, the last player on the
  page has no ›. Esc closes; ✕ closes; backdrop closes. **Scrolling**: the column
  scrolls to the bottom of All Transactions with the ✕ still visible. Mobile
  (`resize_window` preset `mobile`): the cards stack, tables scroll horizontally
  inside their cards, arrows collapse to the prev/next row, nothing overflows the
  viewport. Screenshots: desktop top, desktop scrolled to transactions, mobile.
- Star toggle: toggle on in the modal → close → the Players page row shows ★ (via the
  `router.refresh()`), toggle back.

### Checklist
- [ ] `Modal` `size` + `bare`
- [ ] provider, `PlayerNavList`, `PlayerName`, `PlayerProfileModal` (header / stats / game log + Show More / transactions / star / arrows / keys / sticky ✕ / scroll)
- [ ] layout wraps children; Players page wired with nav list
- [ ] verified in browser (desktop + scrolled + mobile screenshots); PROGRESS.md; committed

---

## Task 4 — Action card inside the modal

### Changes
1. **Extract `AddPlayerCell`** from `PlayerStatsTable.tsx` into
   `src/app/leagues/[id]/players/AddPlayerCell.tsx` (exported, `"use client"`), adding
   optional `onDone?: () => void | Promise<void>` (called after a successful add /
   drop-and-add) and `size?: "cell" | "pill"` (`cell` = today's compact markup for the
   table, `pill` = one full-width `Button variant="primary"` "ADD" and a full-width
   picker for the roster-full case). `PlayerStatsTable` imports it with no props
   changed — zero behaviour change there.
2. **`src/components/player-profile/PlayerProfileActions.tsx`** (`"use client"`) —
   props `{ leagueId; playerId; playerName; status: PlayerLeagueStatus; onChanged: ()
   => Promise<void> }`. Renders the action `Card` with the eight-branch decision, in
   that order, exactly one branch:
   - **DROP**: full-width `Button variant="danger"` → inline `Drop {playerName}?
     [Confirm drop] [Cancel]` → `dropPlayerAction(leagueId, status.viewerTeamId,
     playerId)`; pending/error like `RosterMoveBoard`'s `handleDrop`.
   - **CLAIM** / `Claim pending` + **CANCEL CLAIM**: `submitWaiverClaimAction(leagueId,
     playerId)` / `cancelWaiverClaimAction(leagueId, status.waivers.myPendingClaimId)` —
     call directly and await, not as form actions.
   - **PROPOSE TRADE**: full-width `LinkButton href={\`/leagues/${leagueId}/trades/new?with=${status.ownedBy.teamId}\`}`.
   - **BID**: amount (`min={faab.minBid}`, `max={faab.maxBid ?? undefined}`,
     `defaultValue={faab.minBid}`) + Active/Farm + full-width **BID**; `onSubmit` builds
     `new FormData(form)` and `await submitFaBidAction(leagueId, playerId, formData)`,
     then `onChanged`. `myPendingBid` → `Bid pending: ${amount} → {Active|Farm}` +
     **CANCEL BID** → `cancelFaBidAction(leagueId, myPendingBid.id)`.
   - **ADD**: `<AddPlayerCell size="pill" leagueId teamId={status.viewerTeamId}
     playerId activeCount activeCap activeRosterPlayers onDone={onChanged} />`.
   - Muted-note branches (no team → render nothing; frozen; free agency closed).
   - Every branch surfaces the thrown error inline (`text-xs text-danger`) — the
     mutations' messages are already user-facing.
3. **`PlayerProfileModal.tsx`** — render `<PlayerProfileActions … onChanged={async ()
   => { await reload(); router.refresh(); }} />` between the header card and the Stats
   card when `profile.status.viewerTeamId` is set.

### Verification
- No new mutation script — every mutation is already covered (`roster-action-check.ts`,
  `faab-check.ts`, `waiver-claim-check.ts`, `free-agency-gate-check.ts`); this task adds
  UI entry points. Re-run `scripts/player-profile-check.ts` unmodified — still passes.
- Browser, against a **disposable** league `"Player Modal Actions (delete me)"` seeded
  by a small `scripts/player-modal-test-league.ts` (pattern:
  `header-modal-test-league.ts` / `fit-ux-test-league.ts` — league, two teams,
  throwaway draft, team B sends a ≥80-GP veteran to the farm so he's on waivers; prints
  the league id; `--cleanup` deletes by exact name). With `// TEMP:` bypasses
  (reverted), as team A's manager:
  1. free agent → **ADD** → MANAGER row flips to team A, transactions gains
     `**Added** by …`, the Players page row behind the modal shows the team name after
     refresh;
  2. same player → **DROP** → confirm → MANAGER `Free Agent`, `**Dropped** by …` on top;
  3. fill the active roster to cap via the page, then ADD another → the roster-full
     picker appears inside the modal and Drop & Add works;
  4. the veteran on waivers → **CLAIM** → `Claim pending` + CANCEL CLAIM → cancel →
     CLAIM again;
  5. a player on team B (not on waivers) → **PROPOSE TRADE** lands on
     `/trades/new?with=<teamB>` with team B preselected;
  6. turn FAAB on (LM Tools → Edit League Settings) → a free agent shows the bid form;
     BID → `Bid pending` + CANCEL BID; the Players page's FAAB card lists the same bid;
  7. reset the draft (LM Tools → Reset Draft) so free agency closes → a free agent shows
     the closed note and no button.
  Screenshots of 1, 3, 4, 6. Delete the league by exact name afterwards.

### Checklist
- [ ] `AddPlayerCell` extracted with `onDone` + `size`; Players page unchanged
- [ ] `PlayerProfileActions` — all eight branches
- [ ] modal reloads + `router.refresh()` after success
- [ ] verified in browser (7 flows, screenshots); disposable league deleted; PROGRESS.md; committed

---

## Task 5 — Wire `PlayerName` (+ nav lists) at every remaining site

Mechanical, but each site needs a look — a couple render short names or sit inside
another modal.

### Changes
Replace the bare `{…fullName}` text node with `<PlayerName playerId={…} fullName={…} />`
at each of these (line numbers as of 2026-09-20 — re-grep, don't trust them), and wrap
the sites marked **(nav)** in `<PlayerNavList players={…}>` in rendered order:
1. `teams/[teamId]/RosterMoveBoard.tsx` — the active/farm table rows (~194) **(nav:
   all board rows top to bottom)** and the IR list (~275) **(nav: IR rows)**. Id is
   `r.playerId`.
2. `teams/rosters/page.tsx` (~72) **(nav: per team card)** — pass `className="truncate"`.
3. `matchups/[matchupId]/page.tsx` (~108) **(nav: per side)**.
4. `scoreboard/page.tsx` (~236) — short name as `children`:
   `<PlayerName playerId={p.playerId} fullName={p.fullName}>{shortPlayerName(p.fullName)}</PlayerName>`.
5. `trades/TradeRosterTable.tsx` (~75) **(nav: that table's rows)**,
   `trades/TradeBuilder.tsx` (~211 last-name chips — `children={lastName(p.fullName)}`
   — and ~243), `trades/TradeAssetSummary.tsx` (~42; a **server** component — fine).
   The trade review page and LM Trade Review render through `TradeAssetSummary` —
   confirm by grepping.
6. `draft/DraftRoom.tsx` (~238 pool list **(nav: filtered pool)**) and any
   drafted-players list in the same file; `draft/recap/DraftRecapBoard.tsx` — every
   name cell.
7. `settings/roster-moves/AddPlayerStep.tsx` (~105 — the row's own `onClick` selects
   the player; `PlayerName` stops propagation, so the name opens the modal and the rest
   of the row still selects — check it's usable, otherwise add a separate select
   control), `DropPlayerStep.tsx` (~31), `EditLineupForm.tsx` (~86),
   `ManageFarmStep.tsx` (~27, ~61), `ManageIrStep.tsx` (~28, ~65).
8. **Deliberately left as text** — comment at each: `PlayerSearchBox.tsx` (typeahead),
   `DropPlayerStep.tsx`'s `confirmText` string (a prop, not a render).
9. After wiring: `grep -rn "fullName}" src/app --include=*.tsx` and `grep -rn
   "\.fullName)" src/app --include=*.tsx` — every remaining hit must be a deliberate
   exception, an `alt=`/`title=`, or a string being built. List the survivors in
   PROGRESS.md.

### Verification
- `npx tsc --noEmit`, `npm run build` clean.
- Browser, real "Experimenting" league, read-only, `// TEMP:` reverted: open the modal
  from (a) the team roster board (arrows step through the board), (b) league rosters,
  (c) a matchup detail page, (d) the scoreboard's top scorers (hover shows the full
  name; click opens the right player), (e) the trade builder — from the roster table
  and from a selected-player chip, and **from inside the trade confirm modal** (stacked
  dialogs: the profile opens on top, Esc closes only the profile), (f) the draft
  recap, (g) an LM Roster Moves step. One screenshot of (e) stacked and one of (a) with
  arrows.
- Clicking a name in the trade table must **not** toggle the checkbox; in the draft
  room it must not draft; on the roster board it must not select a mover.

### Checklist
- [ ] every site wired; nav lists where marked; exceptions commented
- [ ] grep sweep recorded in PROGRESS.md
- [ ] verified (a)–(g), no click-through side effects; PROGRESS.md; committed

---

## After the batch

- `BACKLOG.md`: remove the "Player profile modal" item (it now lives in PROGRESS.md).
- `PROGRESS.md` "Known gaps": add the not-built list from "Decisions already made"
  (% rostered, "Consider trade offers?", projections, news/outlook, career table,
  height/weight), and note that `GameStatLine` now carries game context so a future
  "next game" / schedule column has one of its inputs.
- `STAT_RANGES` needs a `2027` entry before Aug 1 2027 or `currentAndLastSeason` falls
  back to the latest entry — leave a dated note in `seasons.ts`.
