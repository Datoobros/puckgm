# Plan — Scoreboard batch (Sept 2026)

Redesign the scoreboard to match ESPN's layout, and build the Matchup detail page its
cards link to. Two tasks, in order, one commit each. **All decisions below are confirmed
with the user — don't re-ask.** Same working rules as the previous plans (`PROGRESS.md`
first; real browser verification; exact-name test-data cleanup on the shared prod
database; `// TEMP:` auth bypasses reverted before commit; commit messages explain *why*).

## Where things are today

- `src/app/leagues/[id]/scoreboard/page.tsx` — `max-w-3xl`; header + `TeamScheduleSelect`
  (a "Week by week / <team>'s schedule" dropdown that switches to a per-team schedule view
  via `?team=`); Prev/Next week buttons with a "Week N of M · dates · Final" line; a
  2-column grid of small cards, each home-left / score-center / away-right with 18px
  top-scorer chips under each name. `?week=N` selects the period.
- Data: `getScoreboardForPeriod(leagueId, season, scoringConfig, periodNo?)` in
  `src/lib/matchups/standings.ts` returns `ScoreboardPeriod` (period info + `matchups[]`
  with names, logos, seeds, scores, `homeTopScorers`/`awayTopScorers`, `final`).
  `getTeamTopScorersForPeriod(teamId, start, end, scoringConfig, limit = 3)` only returns
  players who have `GameStatLine` rows in the period — so it's **empty before any game
  has been played**, which would leave the new middle column blank all pre-season.
- `getTeamScoreForPeriod` sums points for every non-BE `LineupEntry` in the period joined
  to `GameStatLine` — the matchup page's totals must come from the same rows so they
  always equal the scoreboard's scores.
- `/leagues/[id]/standings/bracket` already exists and is titled **"Projected Playoff
  Bracket"** — ESPN's link maps 1:1.
- Teams have no abbreviation field; ESPN's "RS"/"LD" labels must be derived.
- The league home's "Scores" card reuses `getScoreboardForPeriod`; it's unaffected by
  layout changes and benefits from the top-scorer fill below.
- Lineups persist and materialize on view / daily cron (team-page batch Task 4). A
  *future* week nobody has looked at has no lineup rows yet — that's normal.
- `Modal`, `Badge` (tones: muted/gold/navy/warning/danger/success), `Card`, `LinkButton`,
  `TeamLogo`, `PlayerHeadshot` exist in `src/components`. Light-only theme.

## Decisions already made (don't re-open)
- **"Projected Leaders" → "Top Scorers"**: real fantasy points scored in the period. This
  app has no projection source (long-standing decision). Before a week has any games, the
  column shows the team's **started** players ranked by career points at `0.0 pts`, so it
  isn't blank — they're the lineup's real players with a real 0.0. If a team has no
  lineup rows for the period at all, show muted "Lineup not set".
- **"Projected Playoff Bracket"** → link to `/leagues/[id]/standings/bracket`.
- **"Page updates automatically. No need to refresh."** — omitted. No live updates exist;
  don't fake it.
- **Team abbreviation** = initials of the team name's words (first letter of each of up to
  4 words, uppercased; single-word names → first 3 letters). Pure helper, no schema change.
- **Right column** = one `Matchup` button → the new detail page (Task 2). ESPN's
  "Box Score" and "Adjust Scoring" are omitted (no such features). Task 1 renders the
  button pointing at the Task 2 route; it 404s for the few minutes between the two
  commits — acceptable, they ship back to back.
- **Keep the team-schedule dropdown**, right-aligned on the controls row (where ESPN
  shows the auto-refresh note). Nothing else links to `?team=`, so removing it would
  orphan a working view.
- Matchup page shows **per-period aggregates per started player** (games started, points),
  not ESPN's slot-by-slot daily lineup view. Everything it needs exists; the daily view
  is a separate, larger feature.

---

## Task 1 — Scoreboard redesign

### Layout (match the screenshot)
- Container `max-w-6xl`.
- **Header row:** `h1` "Scoreboard" + `Badge tone="muted"` "DYNASTY LEAGUE" / "REDRAFT LEAGUE"
  (from `settings.leagueType`). Right: `LinkButton variant="ghost"` "Projected Playoff Bracket"
  → `/leagues/[id]/standings/bracket`.
- **Controls row:** label "Matchups" (`text-sm font-semibold`) + new client component
  `MatchupWeekSelect` — a `<select>` of **every** period for the season, `router.push`ing
  `?week=N`. Option label: `Matchup ${periodNo} (${range})` for regular season;
  `${roundLabel} (${range})` for playoff periods. `range` = `Sep 29 - Oct 4`, or
  `Oct 5 - 11` when both dates share a month (en-dash or hyphen — match the screenshot's
  hyphen), UTC, `toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })`.
  Next to it a small `Badge`: `Final` (muted) or `In progress` (success) for the selected
  week. Right side of the row: the existing `TeamScheduleSelect`.
  Remove the Prev/Next buttons and the "Week N of M" line.
- **Matchup cards:** one per matchup, full width, stacked with `gap-4`. `Card className="!p-0 overflow-hidden"`,
  inner grid `md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]` (stacks on mobile), columns
  separated by `border-border` dividers.
  - **Col 1 — teams:** two rows (home top, away bottom, divider between), each
    `TeamLogo size={44}` · team name `text-lg font-semibold truncate` (seed as muted
    `(N)` prefix when non-null) · score `text-2xl font-bold tabular-nums` right-aligned.
    Both scores bold like ESPN; the trailing team's name gets `text-muted` only when the
    week is `final`.
  - **Col 2 — top scorers:** two rows aligned with col 1's rows. Each row: a label block
    (`Top Scorers` in `text-sm text-muted`, team initials below in `text-xs font-semibold`)
    then up to three players, each `PlayerHeadshot size={40}` + `F. Lastname`
    (`text-sm font-medium`) + `{points.toFixed(1)} pts` (`text-xs text-muted`). Empty →
    "Lineup not set" muted.
  - **Col 3 — actions:** `LinkButton variant="secondary" className="rounded-full px-5"`
    "Matchup" → `/leagues/[id]/matchups/[matchupId]`, vertically centered.
- Keep the existing empty states ("No schedule yet…", "Bye week for every team…") and the
  `?team=` schedule view exactly as they are.

### Data changes (`src/lib/matchups/standings.ts`)
- New `getTeamPeriodPlayerPoints(teamId, start, end, scoringConfig): Promise<PeriodPlayerPoints[]>`
  where `PeriodPlayerPoints = { playerId, fullName, headshotUrl, primaryPosition, currentNhlOrg, gamesStarted, points }`.
  Source: every non-BE `LineupEntry` in range (distinct players; `gamesStarted` = count of
  distinct dates), joined to `GameStatLine` for points (0 when none). Sort by `points`
  desc, then by career fantasy points desc (one `getPlayerStatsAggregate({ playerIds, scoringConfig })`
  call per team — this is the pre-season tie-break that makes the 0.0 rows meaningful),
  then name.
- `getTeamTopScorersForPeriod` becomes `(await getTeamPeriodPlayerPoints(...)).slice(0, limit)`
  mapped to `TopScorer`. Same signature, so the league-home Scores card keeps working.
- `getTeamScoreForPeriod` unchanged (already sums the same rows).
- New pure helper `teamInitials(name: string): string` (put it in `src/lib/teams/initials.ts`
  or next to `TeamLogo` — anywhere client-safe).

### Verification
- Script `scripts/scoreboard-check.ts`, disposable league (exact name, `deleteLeague`
  cleanup, `(delete me)` on any fixture players): follow `scripts/standings-redesign-check.ts`
  for seeding a schedule (`generateSchedule` with a past `startDate`) and lineup rows with
  stats. Assert `getTeamPeriodPlayerPoints` returns started-but-scoreless players at 0.0
  ordered by career points after the scorers; that `getTeamTopScorersForPeriod` returns ≤3
  and its first entry is the top scorer; that the sum of a team's `PeriodPlayerPoints.points`
  equals `getTeamScoreForPeriod` for the same range.
- `npx tsc --noEmit`, `npm run build`.
- Browser (`preview_start {name: "puckgm-dev"}`, `// TEMP:` bypass in `layout.tsx` + the
  page): the seeded league's scoreboard shows the full-width three-column cards with real
  top scorers and points; the week dropdown lists every period with the right labels and
  switching navigates; the badge flips Final / In progress; the "Projected Playoff Bracket"
  link works; the team-schedule dropdown still switches views. Also open the user's real
  **"Experimenting"** league (`cmts0s1uu0000lc0405mux8c5`, read-only — 22 periods, empty
  rosters) and confirm every card renders with `0.0` and "Lineup not set" without errors.
  Screenshot the seeded scoreboard. Revert bypasses; `grep -rn "TEMP:" src/` clean.
- `PROGRESS.md` section; tick the checklist; commit (don't push).

---

## Task 2 — Matchup detail page

### Route and data
- `src/app/leagues/[id]/matchups/[matchupId]/page.tsx` (server, `auth.protect()`).
  `notFound()` unless the matchup's period belongs to this league.
- New `getMatchupDetail(matchupId, scoringConfig)` in `standings.ts`:
  `{ periodNo, isPlayoffs, roundLabel, startDate, endDate, final, home: { teamId, name, logoUrl, seed, score, players: PeriodPlayerPoints[] }, away: {…} }`
  using `getTeamPeriodPlayerPoints` for `players` and `getTeamScoreForPeriod` for `score`
  (assert in the check script that `score === sum(players.points)`).

### Layout
- `max-w-5xl`. "← Scoreboard" link back to `/leagues/[id]/scoreboard?week=N`.
- Title `{home} vs {away}`; subtitle `Matchup N · Sep 29 - Oct 4 · Final|In progress`
  (playoff: round label instead of "Matchup N"). Reuse Task 1's range formatter — export
  it from wherever Task 1 put it.
- **Score strip:** a `Card` with both teams side by side — logo 56, name, big score
  (`text-4xl font-bold tabular-nums`), the leader bold and the trailer muted when final.
- **Two player tables** (`md:grid-cols-2`, stacked on mobile), one per team, header = team
  name + initials. Columns: Player (`PlayerHeadshot 28`, name, `pos · NHL` muted), `GS`
  (games started), `PTS`. Rows sorted as returned. Footer row: `Total` + team score.
  Empty: "No lineup set for this week yet."
- Link each player name to the Players page? No — no player detail page exists yet
  (backlog item). Plain text.

### Verification
- Extend `scripts/scoreboard-check.ts` (or add `scripts/matchup-detail-check.ts`) to
  assert `getMatchupDetail` totals equal the scoreboard scores for the same matchup and
  that a wrong-league matchup id is rejected.
- `npx tsc --noEmit`, `npm run build`.
- Browser: from the seeded scoreboard click `Matchup` → the page shows both tables with
  the same players/points as the scoreboard's top scorers, totals equal the card's scores;
  back link returns to the same week; a bye-week/empty team shows the empty state. Also
  open one Experimenting matchup (read-only) and confirm the empty state renders.
  Screenshot. Revert bypasses; `grep -rn "TEMP:" src/` clean.
- `PROGRESS.md` section; tick the checklist; mark the batch shipped (date); commit (don't push).

## Checklist
- [ ] Task 1 — scoreboard redesign
- [ ] Task 2 — matchup detail page
