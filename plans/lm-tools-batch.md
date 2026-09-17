# Plan — League Manager Tools batch (Sept 2026)

Rebuild "Commissioner Settings" as an ESPN-style **League Manager Tools** hub — six cards
across the full page width, each a list of link + description rows, every tool on its own
sub-page — and add the tools ESPN has that puckgm doesn't (Roster Moves as a dedicated
flow, Draft Recap, Reset Draft, Edit Waiver Order, Edit Head-to-Head Schedule, Adjust
Scoring, email invitations, named divisions). Twelve tasks, in order, one commit each.
**All decisions below are confirmed with the user — don't re-ask.** Same working rules as
the previous plans (`PROGRESS.md` first; `npx tsc --noEmit` → `npm run build` → real
browser verification via `preview_start {name: "puckgm-dev"}`; exact-name test-data
cleanup on the shared prod database; `// TEMP:` auth bypasses reverted before commit and
`grep -rn "TEMP:" src/` clean; commit messages explain *why*).

**Kickoff prompt for an implementing session:**
> Read `PROGRESS.md`, then `plans/lm-tools-batch.md`. Implement **Task N** only, exactly as
> specified — the design decisions are already made. Verify per the task's Verification
> section, add a short section to PROGRESS.md, tick the task's checklist in the plan,
> commit (don't push).

## The target (ESPN's League Manager Tools, mapped to puckgm)

Hub route stays `/leagues/[id]/settings` (the nav's gold "Commissioner Settings" link
becomes "LM Tools"). Six cards, 3 per row on desktop, full width (`max-w-7xl`), stacking to
one column on mobile. Each row is a title link + one-line description, same as ESPN.

| Card | Row | Route (under `/leagues/[id]/settings/`) | Task |
|---|---|---|---|
| League Membership Tools | Edit Managers and Send Invitations | `managers` | 1, 7 |
| | Assign League Manager Powers | `powers` | 1 |
| Draft Tools *(post-draft toolset for now — user will redesign later)* | Draft Recap | `/leagues/[id]/draft/recap` (public) | 8 |
| | Draft Settings | `draft-settings` | 2 |
| | Reset Draft | `reset-draft` | 9 |
| League and Scoring Settings Tools | Edit League Settings | `league` | 2 |
| | Edit Scoring Settings | `scoring` | 2 |
| | Edit Teams and Divisions | `teams-divisions` | 1, 6 |
| | Delete League | `delete` | 1 |
| | Adjust Scoring | `/leagues/[id]/scoreboard` (commissioner sees Adjust buttons) | 10 |
| Roster Tools | Edit Roster Settings | `roster-settings` | 2 |
| | Roster Moves | `roster-moves` | 3, 4, 12 |
| | Trade Review | `trade-review` | 5 |
| | Edit Waiver Order | `waiver-order` | 5 |
| Schedule and Standings Tools | Edit Schedule Settings | `schedule-settings` | 2 |
| | Edit Head-to-Head Schedule | `/leagues/[id]/schedule` (public view, LM edit) | 11 |
| Miscellaneous Tools | *(empty card with "Nothing here yet." — Transaction Counter and Polls deliberately not built)* | — | 1 |

## Decisions already made (don't re-open)

- **Separate page per tool.** The hub is links only; no accordions, no forms on the hub.
- **Hub is data-driven.** `src/app/leagues/[id]/settings/tools.ts` exports the six cards
  and their rows (`{ title, description, href? }`). A row without `href` renders as a muted
  "Coming soon" line, not a link. Adding a draft tool later = adding one object.
- **Team-page commissioner roster controls go away entirely** (Task 3). One place for
  roster surgery: LM Roster Moves. `CommissionerAddPlayerBox.tsx` is deleted.
- **LM Roster Moves = ESPN's two-step flow**: step 1 "Choose Transaction" (Action / Team /
  Perform as, Continue/Cancel), step 2 the action itself. Actions: **Add Player, Drop
  Player, Manage IR, Manage Farm Team, Make Trade, Edit Lineup** (ESPN's "Edit Roster").
- **"Perform as"** — *League Manager* = full bypass (the existing `commissioner*`
  mutations: no cap, waiver, callup-limit, FAAB, or free-agency checks; still refused on an
  `ORPHAN_FROZEN` team; logged with `commissionerOverride: true`). *Team Manager* = the
  exact manager-facing mutation that team's own manager would call, with
  `managerUserId = team.managerUserId` supplied server-side after the commissioner check —
  every normal rule applies (free-agency gate, FAAB-on refuses instant adds, cap, waiver
  exposure on demotion, weekly callup limit). Whatever it refuses, the page shows the error
  and says "switch to Perform as League Manager to override."
- **LM Make Trade executes immediately** — no acceptance, no 24h review, no veto window.
  Creates a `Trade` in state `PROCESSED` with `proposedByTeamId` = the "from" team, runs
  the same `executeTradeTransfers(tradeId, { bypassRoomCheck: true })` the force-process
  path uses, logs `commissionerOverride: true`. The conflict-of-interest guard does **not**
  apply (the commissioner is acting for both sides, like ESPN) — the audit log is the
  safeguard.
- **Reset Draft = option (b), nuclear**, allowed for a draft in `IN_PROGRESS` or
  `COMPLETE` regardless of what's happened since. The draft goes back to `SETUP` (picks
  kept — pick ownership, including traded picks, is preserved; `usedOnPlayerId` cleared).
  For a **STARTUP** draft every roster in the league is emptied. For a **ROOKIE** draft
  only the players that draft selected are removed (wherever they are now) — a rookie
  draft adds to existing rosters, so wiping everything would be wrong. In-flight trades
  cancelled, pending waiver claims/FA bids voided, lineup rows from today forward deleted.
- **Draft Recap is visible to every league member**, at `/leagues/[id]/draft/recap`,
  linked from the Draft page once a draft is `IN_PROGRESS`/`COMPLETE` and from the hub.
- **Draft Tools card is provisional.** Only what's needed to keep existing setup/start
  working (Draft Settings) plus Recap and Reset. Don't redesign draft setup here.
- **Email invitations via Clerk** (`clerkClient().invitations.createInvitation`), no
  separate email provider. If the address already belongs to a Clerk user, assign the team
  directly instead of inviting. Store `Team.invitedEmail` so the Managers table can show
  "Invited: x@y.com (pending)". Assign-to-team uses a **dropdown of Clerk users**
  (`users.getUserList`), not a pasted user ID.
- **Divisions become named entities** (`League.divisionsJson: string[]`); a team's
  `division` must be one of them or null. Still display/standings-only — no schedule or
  seeding awareness (unchanged).
- **Adjust Scoring**: hub link goes to the Scoreboard; a commissioner sees an "Adjust
  Scoring" link on every matchup card that opens a modal (team, ± points, reason).
  Adjustments are stored (`ScoreAdjustment`) and applied inside `getTeamScoreForPeriod`, so
  standings, scoreboard, matchup detail, team schedule, and playoff advancement all agree.
- **Edit Head-to-Head Schedule** lives on a new public **League Schedule** page
  (`/leagues/[id]/schedule`, ESPN's third screenshot: every matchup period as a table AWAY
  TEAM | MANAGER(S) | SCORE | SCORE | MANAGER(S) | HOME TEAM). Commissioners get an
  **Edit** button per period. Editable only if the period hasn't started (`startDate >
  now`) and isn't a playoff period (bracket rounds are filled by `processDuePlayoffs`).
- **Not built**: Transaction Counter (puckgm has no acquisition limits — building the
  counter means inventing the rule), League Manager Poll (explicitly out of scope since the
  commissioner-tools pass). The Miscellaneous card exists so the layout matches ESPN.
- **Keepers** stay out of scope (ESPN's "Edit League Settings" mentions keeper rules; ours
  doesn't).

## Conventions for every new sub-page

- Lives under `src/app/leagues/[id]/settings/<slug>/page.tsx`, server component, gated by
  the shared `settings/layout.tsx` (Task 1) — **still re-check `isLeagueCommissioner` in
  every Server Action**; the layout gate is UX, the action check is security.
- Header pattern (matches ESPN): `<h1>` tool name + `<Badge tone="muted">DYNASTY LEAGUE</Badge>`
  (or `REDRAFT LEAGUE`), a one-paragraph description, then the content. A "← LM Tools"
  link above the title back to `/leagues/[id]/settings`.
- Width: `mx-auto max-w-7xl px-6 py-8` (the hub and the wide tools — Roster Moves,
  Schedule). Narrow forms (Scoring, Roster Settings, Waiver Order) may use `max-w-3xl`.
- Reuse `Card`, `SectionLabel`, `Button`, `LinkButton`, `Badge`, `ConfirmActionButton`,
  `Modal` from `src/components/`. Native controls use the existing theming classes
  (`rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground`).
- After a successful form action, `redirect` back to the same tool page with `?saved=1`
  and render the existing green "Settings saved." card pattern.

---

## Task 1 — Hub, layout gate, and the membership/teams pages

Turn the single 500-line settings page into the hub plus the first four sub-pages. Pure
restructuring — no new backend behavior.

### Changes
1. **`src/app/leagues/[id]/settings/layout.tsx`** (new). `auth.protect()`, load the league
   (404 if missing), `isLeagueCommissioner` gate → the existing "Only the league
   commissioner can view or change settings." message for non-commissioners. Renders
   `{children}` inside `mx-auto max-w-7xl px-6 py-8`. (Sub-pages don't repeat the gate,
   but their actions do.)
2. **`src/app/leagues/[id]/settings/tools.ts`** (new). Exports
   `LM_TOOL_CARDS: { title: string; rows: { title: string; description: string; href?: (leagueId: string) => string }[] }[]`
   in the table order above. Rows for tools not built yet (Roster Moves, Trade Review,
   Waiver Order, Draft Recap, Reset Draft, Adjust Scoring, Head-to-Head Schedule) have no
   `href` **in this task** — each later task adds its `href`. Descriptions: copy ESPN's
   wording from the screenshots, adapted where puckgm differs (e.g. Draft Recap: "View a
   summary of all draft picks."; Reset Draft: "Roll back a draft and start over.").
3. **`settings/page.tsx`** becomes the hub: `<h1>League Manager Tools</h1>` + league-type
   badge in a full-width header card, then `grid grid-cols-1 gap-6 md:grid-cols-2
   xl:grid-cols-3` of cards. Each card: title, then rows separated by `divide-y
   divide-border`; a row with `href` is `<Link>` (blue, `text-blue hover:underline`) +
   muted description; without, muted "Coming soon" text. The Miscellaneous card renders
   "Nothing here yet." The `justSaved` banner and the DESIGN.md §2.10 warning move to the
   individual settings pages (Task 2).
4. **`settings/managers/page.tsx`** — "Edit Managers and Send Invitations". A **table**
   (not the current stacked forms): columns Team | Manager | Status | Actions. Manager via
   `getUserDisplayName` (`src/lib/users/display.ts`) instead of raw ID; Status shows
   `Orphaned — frozen` / `Co-commissioner` badges. Actions per row: Reassign (keeps the
   current text input for the user ID **in this task** — Task 7 replaces it with a
   picker), Orphan (confirm), Generate/Regenerate claim link (shown inline when present),
   Delete (only when `!hasHistory`, else the "has real history" note). Below the table:
   the Add Team form and the **league invite link** card (moved from the old page:
   generate/regenerate + the "share this to let someone join" copy). Rename and Division
   move to `teams-divisions`, co-commissioner to `powers`.
5. **`settings/powers/page.tsx`** — "Assign League Manager Powers". One list: each team
   with manager display name and a checkbox `Co-commissioner`; one Save button submitting
   all rows (`setCoCommissioner` per changed team, in a new action
   `setCoCommissionersAction(leagueId, formData)` reading `cocomm_<teamId>` checkboxes).
   Only the **primary** commissioner can change these — a co-commissioner sees the list
   read-only with a note ("Only the primary commissioner can change LM powers.").
6. **`settings/teams-divisions/page.tsx`** — "Edit Teams and Divisions". This task: a
   table Team | Name (input) | Division (text input) with a Save-all button calling
   `renameTeam`/`setTeamDivision` for changed rows (new action
   `saveTeamsAndDivisionsAction`). Task 6 upgrades divisions to named entities.
7. **`settings/delete/page.tsx`** — "Delete League": the existing `DeleteLeagueButton`
   with the warning copy.
8. **`src/components/LeagueNav.tsx`**: label "Commissioner Settings" → "LM Tools". Every
   other page that links to `/settings` with the text "Commissioner Settings" (draft
   page, players page — `grep -rn "Commissioner Settings" src/`) → "LM Tools".
9. Old page content that isn't moved in this task (league settings form, draft card,
   schedule card, REDRAFT season card) **stays reachable**: leave it as a temporary
   `settings/legacy/page.tsx` (verbatim move of the remaining form sections, still working)
   and add a temporary muted "Legacy settings page" link at the bottom of the hub. Task 2
   deletes it. This keeps the app fully functional between the two commits.

### Verification
- `npx tsc --noEmit`, `npm run build`.
- Browser (commissioner of a disposable league — create "LM Tools Test League (delete
  me)" via the UI or a small seed script, exact-name cleanup): hub renders six cards full
  width, three per row at desktop width, one per column at `resize_window` mobile; every
  built row navigates; unbuilt rows are not links. Managers table shows a display name;
  orphan → reassign back round-trips (the self-reassign regression from
  `commissioner-tools-check.ts` still passes: run it). Powers: toggle on a second team,
  Save, reload shows it; `setCoCommissioner` still rejects a co-commissioner caller (script).
  Teams & Divisions: rename + set division, Standings groups by it. Delete page works on
  the disposable league at the end (that is the cleanup).
- Non-commissioner: `/settings` and every sub-page show the gate message; nav shows no
  "LM Tools".
- `npx tsx scripts/commissioner-tools-check.ts` still passes.

### Checklist
- [x] layout.tsx gate, tools.ts registry, hub page
- [x] managers / powers / teams-divisions / delete pages
- [x] legacy page holds the not-yet-moved forms; nav label renamed
- [x] verified per above; PROGRESS.md section added; committed

---

## Task 2 — Settings pages: league, scoring, roster, schedule, draft

Split the one big `updateLeagueSettingsAction` form into three pages, move the draft and
schedule cards, delete the legacy page.

### Changes
1. **Partial-update actions** in `src/app/leagues/actions.ts`. `updateLeagueSettings`
   (`src/lib/leagues/mutations.ts`) requires the full input; keep it that way (its
   validation and `LeagueSettingsLog` diffing are correct) and add a small server-side
   helper `currentSettingsInput(leagueId, callerUserId): Promise<UpdateLeagueSettingsInput>`
   that reads the league and maps `LeagueSettings` → input. Each new action spreads that
   and overrides only its own fields:
   - `updateLeagueGeneralSettingsAction` — `faabEnabled/faabBudget/faabMinBid/faabMaxBid`,
     `tradeVetoMode`, `draftPickTradingEnabled`, `tradeDeadline`.
   - `updateScoringSettingsAction` — `scoringConfig` (every `EDITABLE_SCORING_FIELDS` key).
   - `updateRosterSettingsAction` — `farmSlots`, `irSlots`, `waiverGpThreshold`,
     `callupsPerWeek`, `rosterComposition` (numeric fields; `positionMode` from current).
   Delete `updateLeagueSettingsAction` once nothing imports it.
2. **`settings/league/page.tsx`** — "Edit League Settings": the "Locked forever" summary
   (fix its copy — roster composition is *not* locked; say "League size, scoring format,
   league type, and forward position mode never change"), the §2.10 warning card, then
   FAAB / Trades / Trade deadline sections as today, Save. For REDRAFT leagues also the
   **Season** card (`StartNewSeasonButton`) at the bottom.
3. **`settings/scoring/page.tsx`** — "Edit Scoring Settings": the scoring grid, Save.
4. **`settings/roster-settings/page.tsx`** — "Edit Roster Settings": Roster limits +
   Roster composition sections, Save.
5. **`settings/schedule-settings/page.tsx`** — "Edit Schedule Settings": the Schedule card
   (generate form / generated + `ResetScheduleButton`). Fix the copy "One-time — can't be
   regenerated once created" → it can be reset until a week has completed. Add a link to
   `/leagues/[id]/schedule` once Task 11 ships (leave a `TODO(Task 11)` comment for now).
6. **`settings/draft-settings/page.tsx`** — "Draft Settings": the Draft card verbatim
   (drafts list with Start / Open room / `DraftSetupEditForm`, `DraftSetupForm`, Reset
   draft pick ownership). Fix `DraftSetupForm`/`DraftSetupEditForm` imports (`../draft/actions`
   → `@/app/leagues/[id]/draft/actions` style absolute import, since they move a level).
7. Delete `settings/legacy/page.tsx` and its hub link. Update the three `href`s in
   `tools.ts` (league, scoring, roster-settings, schedule-settings, draft-settings were
   already declared in Task 1 — now confirm they exist).
8. The `?saved=1` banner pattern on each of the three settings pages.

### Verification
- `npx tsc --noEmit`, `npm run build`, `grep -rn "updateLeagueSettingsAction\|settings/legacy" src/` empty.
- Script `scripts/lm-settings-split-check.ts` (disposable league, exact-name cleanup):
  calling the three partial paths' underlying merge (export `currentSettingsInput` for the
  script) then `updateLeagueSettings` changes only the intended fields — assert the other
  fields are byte-equal before/after and that `LeagueSettingsLog` rows are written only for
  the changed fields.
- Browser: change one scoring value → saved banner, Standings still renders; change IR
  slots → team page IR label updates; FAAB toggle round-trips; Draft Settings page sets up
  and cancels a draft; Schedule Settings generates and resets a schedule.

### Checklist
- [ ] three partial actions + helper; old action removed
- [ ] league / scoring / roster-settings / schedule-settings / draft-settings pages
- [ ] legacy page deleted; hub fully linked for built tools
- [ ] verified; PROGRESS.md; committed

---

## Task 3 — LM Roster Moves (Add / Drop / Manage IR / Manage Farm) + remove team-page controls

### Changes
1. **`src/lib/rosters/mutations.ts`**: `commissionerAddPlayer` gains
   `targetSlotType?: "ACTIVE" | "FARM" | "IR"` (default `"ACTIVE"`, logged in the payload;
   `ensureLineupMaterialized` only when ACTIVE). Nothing else changes in the bypass
   functions.
2. **`src/app/leagues/[id]/settings/roster-moves/actions.ts`** (new, `"use server"`). Every
   action: `auth.protect()`, `isLeagueCommissioner` or throw, load the team (must be in
   league), then branch on `performAs`:
   - `lmAddPlayerAction(leagueId, teamId, playerId, performAs, targetSlotType)` — LM:
     `commissionerAddPlayer`; TM: `addPlayerToRoster({ managerUserId: team.managerUserId })`
     (ACTIVE only — the form hides the slot select in TM mode).
   - `lmDropPlayerAction(leagueId, teamId, playerId, performAs)` — LM:
     `commissionerDropPlayer`; TM: `dropPlayerFromRoster`.
   - `lmMovePlayerAction(leagueId, teamId, playerId, performAs, targetSlotType)` — LM:
     `commissionerMovePlayer`; TM: map ACTIVE→FARM `sendToFarm`, FARM→ACTIVE
     `callUpToActive`, →IR `placeOnIR`, IR→ACTIVE `activateFromIR` (IR→FARM in TM mode:
     `activateFromIR` then `sendToFarm`, surfacing the waiver-exposure result).
   Return `{ ok: true } | { ok: false, error }` rather than throwing, so the client can show
   the error inline with the "switch to League Manager" hint. Log actor: the existing
   mutations already log; add `performedBy: callerUserId` to the commissioner payloads.
3. **`settings/roster-moves/page.tsx`** + **`RosterMovesFlow.tsx`** (client). Step 1 is
   the ESPN form (two-column definition-list look: label cell left, control right, rows
   separated by borders): Action `<select>` (Add Player / Drop Player / Manage IR / Manage
   Farm Team / Make Trade / Edit Lineup — the last two are listed but disabled with
   "(Task 4)" / "(Task 12)" until built), Team `<select>` (all teams, orphaned ones marked
   and disabled — "reassign first"), Perform as radios with an ⓘ tooltip (`title=`) each:
   *League Manager* — "Bypasses roster caps, waivers, FAAB, and the free-agency gate. Logged
   as a commissioner override." / *Team Manager* — "Runs exactly as if that team's manager
   did it — all normal rules apply." Continue / Cancel (Cancel → hub). Step 1 state goes in
   the URL (`?action=ADD&team=<id>&as=LM`) so step 2 is a server-rendered page and Back
   works.
   Step 2 by action (server component reads the team's current roster via
   `getTeamRosterView` and renders):
   - **Add Player**: a search box (reuse the debounced typeahead shape of the deleted
     `CommissionerAddPlayerBox` — `searchPlayersAction` from
     `src/app/leagues/[id]/players/actions.ts`) → result rows with position/NHL org and,
     in LM mode, a destination select (Active / Farm / IR) + Add button; TM mode: Add
     only. Success → re-render with a green "Added <name> to <team> (<slot>)" line and the
     roster below.
   - **Drop Player**: the team's Active/Farm/IR lists with a Drop button per row
     (confirm).
   - **Manage IR**: Active + Farm lists with "Place on IR", IR list with "Activate to
     Active" / "Activate to Farm".
   - **Manage Farm Team**: Active list with "Send to Farm", Farm list with "Call up".
     (REDRAFT leagues: this action is hidden — no farm.)
   Every step-2 page shows a summary line "Team: X · Performing as: League Manager" with
   a "Change" link back to step 1.
4. **Remove the team-page controls**: in `src/app/leagues/[id]/teams/[teamId]/page.tsx`
   delete every `isCommissionerViewing` branch (lines ~277, 608–618, 858–867, 897, 914,
   943–953, 981–1092 — the prop, the extra `<th>`, the button columns), delete
   `CommissionerAddPlayerBox.tsx`, delete `commissionerAddPlayerAction`/
   `commissionerDropPlayerAction`/`commissionerMovePlayerAction` from
   `teams/[teamId]/actions.ts`. Replace with one line for commissioners viewing another
   team: a muted "Need to edit this roster? Use LM Tools → Roster Moves." link.
5. `tools.ts`: Roster Moves row gets its `href`.

### Verification
- `scripts/lm-roster-moves-check.ts` (disposable league, 2 teams, exact-name cleanup):
  LM add to FARM lands in FARM; TM add on a league whose draft hasn't completed is refused
  by the free-agency gate while LM add succeeds; TM demotion of an 80+ GP player sets
  `waiverExpiresAt`, LM move doesn't; every action refused for a non-commissioner caller;
  every action refused on an `ORPHAN_FROZEN` team in both modes.
- Browser (`// TEMP:` userId): full flow for each of the four actions on a disposable
  league; an error path (TM add with FAAB on) shows the inline error + hint; the team page
  for another team shows no override controls and the pointer line; own team page unchanged.
- `npx tsx scripts/commissioner-tools-check.ts` still passes (it uses the mutations, not
  the deleted UI).

### Checklist
- [ ] `commissionerAddPlayer` slot param; roster-moves actions with performAs
- [ ] step-1 form + four step-2 pages
- [ ] team-page controls and `CommissionerAddPlayerBox` removed
- [ ] verified; PROGRESS.md; committed

---

## Task 4 — LM Make Trade

### Changes
1. **`src/lib/trades/mutations.ts`**: `commissionerExecuteTrade({ leagueId, fromTeamId,
   toTeamId, give, receive, callerUserId })`. Commissioner check; both teams in league and
   not `ORPHAN_FROZEN`; reuse `buildProposalItems` + `assertPlayersNotOnWaivers` + the
   ownership validation `proposeTrade` does (extract the shared validation into a private
   helper rather than duplicating — `proposeTrade` calls it too); create the `Trade` with
   `state: "PROCESSED"`, `respondedAt: now`, then `executeTradeTransfers(tradeId, {
   bypassRoomCheck: true })`; write a `TransactionLog` `TRADE` row with
   `commissionerOverride: true, performedBy: callerUserId` (mirror whatever payload shape
   the force-process path logs — read it first). All in one transaction where the
   existing helpers allow; otherwise same sequencing as `forceProcessTrade`.
2. **`TradeBuilder.tsx`** gains `mode?: "propose" | "commissioner"` (default `"propose"`)
   and `submitAction?` — in commissioner mode: labels "Your team"/"Their team" become the
   two team names, the review modal's button says "Execute trade", the fit-check step is
   skipped (bypass), and submit calls `commissionerExecuteTradeAction` then routes to
   `/settings/roster-moves?done=trade&tradeId=…`. Keep the propose path byte-identical.
3. **`settings/roster-moves`** step 2 for **Make Trade**: a second team select ("Trade
   with") then the builder, loading both teams' `getTradeableAssets` + `statsById` the way
   `trades/new/page.tsx` does. Perform-as is ignored for trades (always immediate) — the
   step-1 radios are hidden when Action = Make Trade, with a note.
4. `/trades` page and `/trades/[tradeId]` render a `PROCESSED` commissioner trade in
   history with a `Badge tone="gold">LM trade</Badge>` (detect via the log payload or add
   `Trade.commissionerExecuted Boolean @default(false)` — add the column; it's cleaner
   than sniffing logs. Migration `add_trade_commissioner_executed`).

### Verification
- `scripts/lm-trade-check.ts`: 2-team disposable league, roster players + a pick; execute a
  player-for-pick LM trade → roster slots moved, pick `currentOwnerId` changed, trade
  `PROCESSED` + `commissionerExecuted`, exactly one TRADE log with `commissionerOverride`;
  refused for a non-commissioner; refused when a player is on waivers; refused when a
  team is frozen; a trade that overflows the receiving roster still executes (bypass).
- Browser: full flow; the Trades page history shows the LM badge.

### Checklist
- [ ] `commissionerExecuteTrade` + shared validation helper
- [ ] TradeBuilder commissioner mode; Make Trade step 2
- [ ] `Trade.commissionerExecuted` + badge
- [ ] verified; PROGRESS.md; committed

---

## Task 5 — Trade Review page + Edit Waiver Order

### Changes
1. **`settings/trade-review/page.tsx`** — "Trade Review": `getTradesForLeague` filtered
   to `PROPOSED` / `UNDER_REVIEW`, one card per trade: both teams, items each way
   (`TradeAssetSummary` is reusable), proposed/review-ends timestamps, and actions
   **Veto** (`castVetoAction`, only when `tradeVetoMode === "COMMISSIONER"` and the caller
   isn't a party — same `canVeto` logic as `trades/page.tsx`; factor that predicate into
   `src/lib/trades/permissions.ts` and use it from both pages), **Force through now**
   (`forceProcessTradeAction`, UNDER_REVIEW only, same guard), **Cancel** (`cancelTradeAction`,
   PROPOSED only). Empty state: "No trades awaiting review." Below: last 10 resolved trades
   with state badges, read-only.
2. **`src/lib/waivers/mutations.ts`**: `setWaiverPriority({ leagueId, orderedTeamIds,
   callerUserId })` — commissioner check; the id set must equal the league's team id set
   exactly (no dupes, none missing); writes `waiverPriorityJson`.
3. **`settings/waiver-order/page.tsx`** + client `WaiverOrderEditor.tsx`: numbered list
   from `getOrInitWaiverPriority`, ▲ ▼ buttons per row (client state), Save submits the
   order as hidden inputs → `setWaiverPriorityAction`. Copy: "1 = first claim. A team that
   wins a claim rotates to the bottom automatically."
4. `tools.ts`: both rows get `href`s.

### Verification
- `scripts/lm-waiver-order-check.ts`: set a new order, `getOrInitWaiverPriority` returns
  it; a missing/duplicate id is rejected; non-commissioner rejected; a later
  `rotatePriorityToBack` (via an awarded claim in the existing `waiver-claim-check.ts`
  shape, or exported for the test) still rotates correctly on top of the new order.
- Browser: reorder + save round-trips; Trade Review shows a seeded PROPOSED trade and
  Cancel removes it; Veto/Force buttons absent when the commissioner is a party.

### Checklist
- [ ] trade-review page + shared `canVeto/canForce` predicate
- [ ] `setWaiverPriority` + editor page
- [ ] verified; PROGRESS.md; committed

---

## Task 6 — Named divisions

### Changes
1. Prisma: `League.divisionsJson Json?` (string array), migration `add_league_divisions`.
2. **`src/lib/leagues/mutations.ts`**: `getLeagueDivisions(leagueId): string[]`;
   `setLeagueDivisions({ leagueId, callerUserId, divisions: string[] })` — trimmed,
   unique, non-empty names; renaming is expressed as `{ from, to }` pairs in a separate
   `renameLeagueDivision` so teams follow; removing a division clears `division` on its
   teams. `setTeamDivision` now requires the value to be in the list (or null).
3. **`settings/teams-divisions/page.tsx`** upgrade: top section "Divisions" — list with
   inline rename input + Remove, and an "Add division" input; bottom section the team table
   from Task 1 with Division as a `<select>` (None + the list). One Save each.
4. Standings page: unchanged (already groups by `Team.division`); verify the "No division"
   bucket still works for unassigned teams.

### Verification
- `scripts/lm-divisions-check.ts`: add two divisions, assign, rename one → teams follow,
  remove one → its teams cleared, assigning a nonexistent name rejected.
- Browser: Standings groups by the new names.

### Checklist
- [ ] schema + mutations
- [ ] page upgrade
- [ ] verified; PROGRESS.md; committed

---

## Task 7 — Email invitations and assign-by-picker

### Changes
1. Prisma: `Team.invitedEmail String?`, migration `add_team_invited_email`.
2. **`src/lib/users/directory.ts`** (new): `listKnownUsers(): Promise<{ id, name, email }[]>`
   via `clerkClient().users.getUserList({ limit: 100, orderBy: "-created_at" })`, mapped
   with the same name fallback as `getUserDisplayName`; `findUserByEmail(email)` via
   `getUserList({ emailAddress: [email] })` (exact match on the returned addresses — the
   API is a partial match, so filter client-side). Best-effort like `display.ts` (catch →
   empty list / null).
3. **`src/lib/leagues/invitations.ts`** (new): `inviteManagerByEmail({ leagueId, teamId,
   email, origin, callerUserId })` — commissioner check; team in league; if
   `findUserByEmail` hits: `setTeamManager({ newManagerUserId })` and return
   `{ assigned: true }`; else ensure a claim code (`regenerateTeamClaimCode` if none),
   `clerkClient().invitations.createInvitation({ emailAddress, redirectUrl:
   `${origin}/invite/team/${claimCode}`, ignoreExisting: true })`, set `invitedEmail`,
   return `{ assigned: false }`. `inviteToLeagueByEmail({ leagueId, email, origin,
   callerUserId })` — same with `redirectUrl = ${origin}/invite/${inviteCode}` (generate
   one if missing); no team row to mark, so the page just shows "Invitation sent."
   `claimTeam` clears `invitedEmail`.
4. **`settings/managers/page.tsx`**: Reassign becomes a `<select>` of `listKnownUsers`
   (name + email), excluding users already managing a team in this league; per row an
   "Invite by email" input + button (for commissioner-owned placeholder or orphaned
   teams; for a team with a real manager it's labelled "Replace manager by email" with a
   confirm); a Status cell value "Invited: x@y.com (pending)" when `invitedEmail` is set
   and the team is still unclaimed. Bottom card: "Invite to league by email" (creates a
   new team on sign-up via the league invite link) alongside the shareable link.
5. Copy the ⓘ note ESPN doesn't need but we do: "Invitations are sent by our sign-in
   provider (Clerk). Someone who already has an account is assigned immediately instead."

### Verification
- Script can't send real email — `scripts/lm-invitations-check.ts` covers the
  already-has-account branch (use the user's own second Clerk identity from earlier
  verification, looked up by email — read it from an env var `TEST_SECOND_USER_EMAIL`,
  skip that assertion with a printed notice if unset) and the validation paths (bad
  email, non-commissioner, team not in league).
- Browser: invite a throwaway address you control (a `+alias` of your own Gmail) → Clerk
  sends the email; the link signs up and lands on the claim page; the Managers table shows
  the pending state before and the real manager after. Then delete the disposable league.
  **Note in PROGRESS.md** whether Clerk's Development instance actually delivered the email
  (it should; if it's throttled, say so).

### Checklist
- [ ] schema; directory + invitations modules
- [ ] managers page picker + invite controls
- [ ] verified (including a real email round-trip); PROGRESS.md; committed

---

## Task 8 — Draft Recap (public)

### Changes
1. **`src/lib/draft/mutations.ts`**: `getDraftRecap(draftId)` → draft meta + picks ordered
   by `overallPick` with round, pick-in-round, original team, current owner (if traded),
   player (name, position, NHL org, headshot), and whether it was autopicked/forced (from
   the `DRAFT_PICK` `TransactionLog` payload — join by `playerId` + draft; if the join is
   awkward, add `DraftPick.autopicked Boolean?` set by `recordPick` going forward and read
   the log only as a fallback).
2. **`src/app/leagues/[id]/draft/recap/page.tsx`** — any signed-in league member (same
   membership rule the Draft page uses). Header + draft select if the league has more than
   one non-SETUP draft (`?draft=<id>`). Two views via a toggle: **By round** (tables per
   round: Pick | Team | Player | Pos | NHL) and **By team** (one column per team, picks
   listed in order). `AUTO` badge where autopicked. Empty state for a draft still in
   `SETUP`.
3. Draft page: when the current draft is `IN_PROGRESS`/`COMPLETE`, a "View draft recap"
   link under the heading; the "Draft complete" message in `DraftRoom.tsx` gets the same
   link.
4. `tools.ts`: Draft Recap `href` → `/leagues/[id]/draft/recap`.

### Verification
- Against the real "Experimenting" league's completed draft (read-only!) — recap counts
  match `DraftPick` rows with `usedOnPlayerId`; a non-member gets the not-a-member message.
- Browser: both views render; the AUTO badge appears on autopicked rows.

### Checklist
- [ ] `getDraftRecap`; recap page; links
- [ ] verified; PROGRESS.md; committed

---

## Task 9 — Reset Draft

### Changes
1. **`src/lib/draft/reset.ts`** (new file — NOT inside `draft/mutations.ts`:
   `trades/mutations.ts` already imports `assertNoDraftInProgress` from there, so
   importing `cancelTrade` back into `draft/mutations.ts` would be circular; a sibling
   file that imports from both is fine, same shape as `leagues/season.ts`):
   `resetDraft({ draftId, callerUserId })` — commissioner check; status must be
   `IN_PROGRESS` or `COMPLETE`. Read `src/lib/leagues/season.ts` first — `startNewSeason`
   already does the in-flight-trade cancellation + league-wide roster close + lineup wipe
   inline; **extract those steps into an exported helper there
   (`wipeLeagueRosters(leagueId, callerUserId, { onlyPlayerIds? })`) and call it from
   both** rather than duplicating. Steps, same careful sequencing season.ts uses:
   - Cancel every `PROPOSED`/`UNDER_REVIEW` trade in the league (`cancelTrade` with
     `allowUnderReview`).
   - Void pending `WaiverClaim`s and `FaBid`s for the league's teams.
   - **STARTUP**: close every open `RosterSlot` (`effectiveTo: now`) for every team in the
     league. **ROOKIE**: close only open slots whose `playerId` is a `usedOnPlayerId` of
     this draft's picks.
   - Delete `LineupEntry` rows with `gameDate >= todayUTC()` for the affected teams.
   - `DraftPick` rows of this draft: `usedOnPlayerId: null` (keep `round`, `overallPick`,
     ownership). `Draft`: `status: "SETUP"`, `currentPickDeadline: null`, `resolvingUntil: null`.
   - One `TransactionLog` `COMMISSIONER_RESET` row with counts.
   Leave historical `DRAFT_PICK` logs in place (the recap must show nothing for a SETUP
   draft — it reads picks, not logs, so that's already true).
2. **`settings/reset-draft/page.tsx`** — lists resettable drafts with what will happen
   (team count, open slots to close, picks to un-use — computed live), a typed-confirmation
   input (must equal the league name) and the Reset button. Draft Settings page also links
   here from a resettable draft's row.
3. `tools.ts`: Reset Draft `href`.

### Verification
- `scripts/lm-reset-draft-check.ts`: disposable 2-team league; run a 4-pick STARTUP draft
  via `autodraftBatch` (as `draft-autodraft-check.ts` does), add an extra free-agent, then
  `resetDraft` → 0 open slots league-wide, draft `SETUP`, 4 picks with `usedOnPlayerId`
  null and unchanged `overallPick`, free agency locked again (`getFreeAgencyStatus`), then
  `startDraft` + autodraft again succeeds (the true "start over"). ROOKIE variant: seed a
  non-draft roster player, run the reset, assert he survives and only drafted players are
  gone. Non-commissioner and `SETUP`-status refusals.
- Browser: the confirm page and a full reset on the disposable league.

### Checklist
- [ ] `resetDraft` (STARTUP wipe / ROOKIE targeted), reusing season.ts helpers
- [ ] reset page with typed confirmation
- [ ] verified; PROGRESS.md; committed

---

## Task 10 — Adjust Scoring

### Changes
1. Prisma: `model ScoreAdjustment { id, leagueId, matchupPeriodId → MatchupPeriod,
   teamId → Team, points Float, reason String?, createdBy String, createdAt }`, migration
   `add_score_adjustment`. Add it to `deleteLeague`'s child-deletion order and to
   `teamHasHistory` (an adjusted team has history).
2. **`src/lib/matchups/standings.ts`**: change `getTeamScoreForPeriod(teamId, start, end,
   scoringConfig)` → `getTeamScoreForPeriod(teamId, period: { id: string; startDate: Date;
   endDate: Date }, scoringConfig)`; sum `ScoreAdjustment.points` for `(teamId,
   matchupPeriodId)` into the result. Update all seven call sites (standings.ts ×5,
   playoffs.ts ×1 — they all already hold the period object). `getMatchupDetail` returns
   `adjustments: { id, points, reason, createdAt }[]` per side so the detail page can show
   an "Adjustments" line under the player table and the totals still reconcile.
3. **`src/lib/matchups/adjustments.ts`** (new): `addScoreAdjustment({ leagueId,
   matchupPeriodId, teamId, points, reason, callerUserId })` (commissioner; team must be in
   one of that period's matchups; `points` finite, non-zero), `removeScoreAdjustment({ id,
   callerUserId })`, `listScoreAdjustments(matchupPeriodId)`.
4. Scoreboard: `MatchupCard` gets an `adjustLink` slot — for commissioners an "Adjust
   Scoring" text link under the Matchup button (ESPN's placement) opening
   `AdjustScoringModal.tsx` (client, `Modal`): team radio (home/away), points input
   (`step="0.1"`, negative allowed), reason, Save; below, the existing adjustments for
   both teams in this period with Remove buttons. `getScoreboardForPeriod` includes
   `adjustments` per matchup so the modal has them without a second fetch. The card's
   score line shows a small `(adj.)` marker when a side has any adjustment.
5. Matchup detail page: "Adjustments" line per side.
6. `tools.ts`: Adjust Scoring `href` → `/leagues/[id]/scoreboard`.

### Verification
- `scripts/lm-adjust-scoring-check.ts` (reuse `scoreboard-seed.ts`'s shape): +5.5 on the
  home team of a completed period flips a loss to a win in `getStandings` and the
  scoreboard total; removing it restores; playoff advancement (`advancePlayoffsForLeague`)
  honors the adjusted score; team not in the period's matchups rejected; non-commissioner
  rejected. Run `scoreboard-check.ts`, `standings-redesign-check.ts`, `playoffs-check.ts`
  clean after the signature change.
- Browser: modal add/remove; standings and matchup detail reflect it.

### Checklist
- [ ] schema (+ deleteLeague/teamHasHistory); `getTeamScoreForPeriod` signature + all call sites
- [ ] adjustments module; scoreboard modal; detail line
- [ ] verified; PROGRESS.md; committed

---

## Task 11 — League Schedule page + Edit Head-to-Head Schedule

### Changes
1. **`src/lib/matchups/standings.ts`**: `getLeagueSchedule(leagueId, season,
   scoringConfig)` → every period (regular + playoff) with its matchups, both teams'
   names/logos/records-to-date (W-L-T through the previous completed period) and scores
   (via the Task 10 signature), manager display names via `getUserDisplayName` (batch the
   lookups; co-manager included as "A, B" like ESPN).
2. **`src/lib/matchups/mutations.ts`**: `updatePeriodMatchups({ leagueId, periodId, pairs:
   { homeTeamId, awayTeamId }[], callerUserId })` — commissioner; period in league; refuse
   if `isPlayoffs` ("bracket rounds are filled from standings") or `startDate <= now`
   ("this week has started"); every team id in league; no team appears twice; a team
   absent from `pairs` simply has a bye that week (allowed — that's how odd counts work
   already). Delete the period's matchups and `createMany` the new ones in one
   transaction.
3. **`src/app/leagues/[id]/schedule/page.tsx`** (public to members) — ESPN's League
   Schedule: title + badge, "Projected Playoff Bracket" link (existing
   `/standings/bracket`), Season select (`getAvailableSeasons`) and Team filter
   (`?team=`), then per period: "Matchup N (Sep 29 – Oct 4)" heading (playoff rounds use
   `playoffRoundLabel`) and the six-column table. Commissioner-only **Edit** pill button
   beside eligible headings → `?edit=<periodId>` renders that period as
   `PeriodEditor.tsx` (client): one row per matchup with Away `<select>` / Home
   `<select>`, "Remove matchup", "Add matchup", live validation message (duplicate team),
   Save (→ `updatePeriodMatchupsAction`) / Cancel.
4. Scoreboard page header: a "Full schedule" ghost link next to "Projected Playoff
   Bracket". Schedule Settings page (Task 2's TODO): link to the schedule page.
5. `tools.ts`: Edit Head-to-Head Schedule `href` → `/leagues/[id]/schedule`.

### Verification
- `scripts/lm-schedule-edit-check.ts`: 4-team disposable league, generated schedule
  starting next week; swap pairings in week 2 → rows replaced, `teamHasHistory` still true
  for all; a duplicate team rejected; editing week 1 after backdating its `startDate`
  rejected; editing a playoff period rejected; `getStandings` unaffected by a future-week
  edit. Run `playoffs-check.ts` and `scoreboard-check.ts` clean.
- Browser: schedule page renders all weeks with manager names; Edit → swap → Save →
  table and Scoreboard show the new pairing; non-commissioner sees no Edit buttons.

### Checklist
- [ ] `getLeagueSchedule`, `updatePeriodMatchups`
- [ ] schedule page + period editor; links from scoreboard/settings
- [ ] verified; PROGRESS.md; committed

---

## Task 12 — LM Roster Moves: Edit Lineup

Deliberately last and deliberately simple — the team page's click-to-move board
(`RosterMoveBoard.tsx`) is built around the page's 1,100 lines of row assembly and isn't
worth extracting for a rarely used commissioner path.

### Changes
1. **`src/lib/lineups/mutations.ts`**: nothing new — `setLineupSlot`/`swapLineupSlots`
   are called with `managerUserId = team.managerUserId` from the action after the
   commissioner check (Perform-as is ignored for lineups; game-time locks always apply —
   say so on the page).
2. **`settings/roster-moves`** step 2 for **Edit Lineup**: date picker (default today,
   `DateStrip.tsx` is reusable if it's not page-coupled; otherwise a plain `<input
   type="date">`), then a table of the Active roster: Player | Pos | Today's game | Slot
   `<select>` (eligible slots for that position from the same eligibility helper the team
   page uses — find it in `src/lib/lineups/mutations.ts` / `moveTypes.ts` and import, don't
   copy) with locked players' selects disabled and a lock icon. Save applies changes in
   order via `swapLineupSlots`/`setLineupSlot`, reporting the first error inline.
3. Enable the "Edit Lineup" option in the step-1 select.

### Verification
- `scripts/lm-edit-lineup-check.ts`: commissioner sets a slot on another team → the
  team's `getLineupForDate` reflects it; a locked (game started, backdated) player is
  refused; non-commissioner refused.
- Browser: change two slots, Save, the team page shows the new lineup.

### Checklist
- [ ] Edit Lineup step 2; option enabled
- [ ] verified; PROGRESS.md; committed

---

## After the batch

- `PROGRESS.md`: replace the old "Commissioner tools" section's UI description with a
  pointer to the hub and this plan; list the not-built rows (Transaction Counter, Poll)
  under "Known gaps".
- The Draft Tools card is the user's next design pass — leave `tools.ts` easy to extend.
