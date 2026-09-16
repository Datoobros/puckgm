# Plan — Trades batch (Sept 2026)

Six user-reported trade issues, planned in one pass. **Every design decision below has
already been confirmed with the user — do not re-ask them.** If you hit something this plan
genuinely doesn't cover, say so in your final report rather than guessing.

Same working rules as `plans/team-page-batch.md` ("How to use this plan") — read
`PROGRESS.md` first, one task per session, one commit per task, in order, real browser
verification, exact-name test-data cleanup on the shared prod database, `// TEMP:` auth
bypasses reverted before commit, commit messages that explain *why*.

**Prerequisite:** every task in `plans/team-page-batch.md` must be committed first (Task 4
of that batch edits `rosters/mutations.ts` and the team page, both of which this batch
also touches). Check `git log` before starting.

## Execution order

| # | Task | Issue(s) | Size |
|---|------|----------|------|
| 1 | Trade integrity: locks, fit checks, accept/propose validation, stuck-trade notice | #4, #5 (backend) | M–L |
| 1b | Trade hardening: pick locks, stuck-trade auto-cancel, FAAB freeze, draft freeze, accept re-checks (loophole audit) | audit | M |
| 2 | Trades page split + ESPN-style builder + confirm modal + redirect to My Team | #1, #2, #3 | L |
| 3 | Roster-fit UX: "drop N players" flow on send and on accept; locked-player UI | #4, #5 (UI) | M |

Issue #6 (commissioner instantly pushing trades through) is **out of scope** — see the
note at the end.

## Where things are today (read before Task 1)

- `src/lib/trades/mutations.ts` — `proposeTrade`, `respondToTrade`, `cancelTrade`,
  `castTradeVeto`, `executeTradeTransfers`, `forceProcessTrade`, `processDueTrades`,
  `getTradeableAssets`, `getTradesForLeague`, `getTradeDetailById`. Private
  `wouldFitAfterTrade(trade)` returns a bare boolean and is only called at *processing*
  time (cron / force). It imports `activeRosterCap` from `rosters/mutations.ts` and
  `getAvailableBudget`/`getOrInitFaabBudget` from `faab/mutations.ts`.
- `src/app/leagues/[id]/trades/page.tsx` — one page doing everything: builder card on
  top, then Needs your response / Waiting / Pending / **History** lists.
  `TradeBuilder.tsx` (client) is a two-column "You give | You get" checklist with a
  full-page "review" step and a `<form action={proposeTradeAction}>` Confirm & Send.
  `TradeAssetSummary.tsx` has `PlayerStatLine` (compact wrapped stats) and the two-card
  summary, shared with the review page. `actions.ts` has propose / respond / counter /
  cancel / veto / force actions; `respondToTradeAction` redirects to `/trades`,
  `proposeTradeAction` only revalidates (stays on the page — hence "spam send").
- `src/app/leagues/[id]/trades/[tradeId]/review/page.tsx` — Accept / Decline / Counter
  for the counterparty. No fit information.
- Team page action bar (`RosterMoveBoard.tsx`) has `Propose Trade` → `/trades`
  (added in the team-page batch). `dropMode` there is client state, not URL-driven.
- `Modal` component exists (`src/components/Modal.tsx`, native `<dialog>`, from the
  team-page batch) — reuse it for every modal in this plan.
- Notifications feed (`src/lib/notifications/feed.ts`) already emits TRADE_ACTION /
  TRADE_PENDING items from `getTradesForLeague`.
- Free agency is gated until the draft (`assertFreeAgencyOpen`, team-page batch Task 3):
  test scripts can't roster players via `addPlayerToRoster` on a fresh league — use
  `commissionerAddPlayer` (ungated) or run a quick programmatic draft
  (`scripts/free-agency-gate-check.ts` shows how). **`scripts/trades-check.ts` and
  `scripts/trade-review-check.ts` predate that gate and will need the same fix.**

### Confirmed bugs (what #4/#5 actually are)
1. `respondToTrade` (accept) checks nothing about rosters: not fit, not even whether the
   items are still owned. `executeTradeTransfers` then skips a missing player
   (`if (!oldSlot) continue; // defensive`) and marks the trade PROCESSED — a half-executed
   trade.
2. Nothing prevents a player in an accepted (UNDER_REVIEW) trade from being dropped,
   sent to farm/IR, called up, put in another trade, or claimed off waivers.
3. Fit is only evaluated at processing time; a non-fitting trade silently stays
   UNDER_REVIEW forever with no message to anyone.

### Circular-import trap (same shape as the team-page batch)
`trades/mutations.ts` imports from `rosters/mutations.ts`. The lock check has to run
*inside* `rosters/mutations.ts` (drop/farm/IR/callup) and `waivers/mutations.ts`, so it
cannot live in `trades/mutations.ts`. Put it in a new leaf module
**`src/lib/trades/locks.ts` that imports only `@/lib/db`**. `rosters/`, `waivers/`, and
`trades/mutations.ts` all import from it; it imports from none of them.

---

## Task 1 — Trade integrity (issues #4 & #5, backend)

### Rules (confirmed with the user)
- **Locked players.** A player who is a PLAYER item in any trade with `state:
  UNDER_REVIEW` in his league is *locked*: he can't be dropped, sent to farm, called up,
  placed on / activated from IR, included in a new trade proposal, or claimed on
  waivers. **Lineup slot changes are still allowed** (he still plays for his current
  owner until the trade processes — matches ESPN). Commissioner override functions
  (`commissionerDropPlayer`, `commissionerMovePlayer`, `commissionerAddPlayer`,
  `forceProcessTrade`) are **not** gated.
- **Players on waivers can't be traded.** A FARM slot with `waiverExpiresAt > now` means
  another team may claim him mid-trade; block him at propose time and at accept time
  rather than trying to reconcile a claim against a pending trade.
- **Accepting re-validates everything** as if proposing fresh: every PLAYER item still
  owned by `fromTeamId`, every PICK still `currentOwnerId === fromTeamId`, FAAB amounts
  still available, no player locked by *another* UNDER_REVIEW trade, nobody on waivers.
  Any failure → throw with a specific message naming the item.
- **Fit is checked by the acceptor for their own roster at accept time, and by the
  proposer for their own roster at propose time.** Each side is responsible for their own
  room; the other side's overflow is informational. A trade can therefore reach
  UNDER_REVIEW with the proposer's roster no longer fitting (they added players after
  proposing) — that's what the stuck-trade notification is for.
- **Accepting supersedes other proposals.** When a trade is accepted, every other
  `PROPOSED` trade in the league that includes any of the same players (either side) is
  set to `CANCELLED` in the same transaction, with a log payload
  `{ event: "SUPERSEDED", byTradeId }`. Otherwise those proposals could be accepted later
  and fail at processing.
- **Processing behaviour is unchanged:** if a trade doesn't fit when its review window
  ends it stays UNDER_REVIEW and retries daily (existing, deliberate). What's new is that
  the team blocking it gets told.

### Changes
1. **`src/lib/trades/locks.ts`** (new leaf module, imports only `prisma`):
   ```ts
   /** playerId -> tradeId for every player locked by an UNDER_REVIEW trade in this
    *  league; `playerIds` narrows the query when given. */
   export async function getTradeLockedPlayerIds(leagueId: string, playerIds?: string[]): Promise<Map<string, string>>
   /** Throws "<Name> is locked in a pending trade and can't be <what> until it processes." */
   export async function assertPlayersNotTradeLocked(leagueId: string, playerIds: string[], what: string): Promise<void>
   ```
   Query: `tradeItem.findMany({ where: { itemType: "PLAYER", playerId: { in }, trade: { leagueId, state: "UNDER_REVIEW" } }, include: { player: { select: { fullName: true } } } })`.
2. **`src/lib/trades/mutations.ts`**:
   - Replace private `wouldFitAfterTrade` with exported
     `computeTradeFit(leagueId, items): Promise<TradeFit>` where
     `TradeFit = { fits: boolean; overflow: { teamId: string; slotType: "ACTIVE" | "FARM" | "IR"; excess: number }[] }`
     — same arithmetic as today, but reporting *how many* over, per team, per tier.
     `executeTradeTransfers` uses `.fits`.
   - Export `buildProposalItems({ proposingTeamId, counterpartyTeamId, give, receive })`
     (pure — extract the item-list construction from `proposeTrade`) so the builder's
     fit-check action (Task 3) and `proposeTrade` share it.
   - Export `assertPlayersNotOnWaivers(playerIds)` — throws naming the player and his
     `waiverExpiresAt`.
   - **`proposeTrade`**, after `assertOwnsAssets`: `assertPlayersNotTradeLocked` (both
     sides, what = `"traded"`), `assertPlayersNotOnWaivers` (both sides), then
     `computeTradeFit` on the would-be items → if the **proposer** has any overflow, throw
     `"This trade would leave you N over your <Active/Farm/IR> roster cap — drop N player(s) first or add more of yours to the offer."`
     (worst tier first if several).
   - **`respondToTrade`** accept path: run the full re-validation listed under Rules
     (reuse `assertOwnsAssets`, the two new asserts, and a FAAB availability re-check),
     then `computeTradeFit` → if the **counterparty/acceptor** overflows, throw
     `"You must drop N player(s) to accept this trade."`; then in one `$transaction`: flip
     to UNDER_REVIEW as today + cancel superseded PROPOSED trades + logs.
   - **`getTradeableAssets`**: each player gains `lockedInTradeId: string | null` and
     `onWaiversUntil: Date | null` (from `waiverExpiresAt`), so the builder can disable
     those rows with a reason.
3. **`src/lib/rosters/mutations.ts`** — `assertPlayersNotTradeLocked(leagueId, [playerId], "…")`
   before any write in `dropPlayerFromRoster` ("dropped"), `sendToFarm` ("sent to the farm"),
   `callUpToActive` ("called up"), `placeOnIR` ("placed on IR"), `activateFromIR`
   ("activated"), and `addPlayerToRoster`'s drop branch (the `dropPlayerId`). Commissioner
   functions untouched. Import from `@/lib/trades/locks` only.
4. **`src/lib/waivers/mutations.ts`** — `submitWaiverClaim`: assert the claimed player
   isn't locked (belt-and-braces; a locked player can't newly reach waivers because
   `sendToFarm` is gated, but a claim could already exist from before). Also in
   `respondToTrade`'s accept validation, if a player has `PENDING` waiver claims the
   waivers-check above already throws (he's on waivers) — no separate handling needed.
5. **`src/lib/notifications/feed.ts`** — for each UNDER_REVIEW trade involving my team
   whose `reviewEndsAt <= now`, call `computeTradeFit`; if *my* team overflows →
   `kind: "TRADE_ACTION"`, text `"Trade with X is waiting on you — drop N player(s) to complete it"`,
   href `/leagues/[id]/teams/[myTeamId]?dropMode=1&pendingTrade=<tradeId>` (Task 3 makes
   that URL do something; the link is harmless before then). If the *other* team
   overflows → `kind: "TRADE_PENDING"`, `"Trade with X is waiting on them to clear roster room"`.
   The existing "under review until …" item stays for trades still inside their window.
6. **Existing scripts**: `scripts/trades-check.ts` and `scripts/trade-review-check.ts`
   must still pass. Expect two kinds of breakage to fix in-script: rostering via
   `addPlayerToRoster` on a league with no draft (switch to `commissionerAddPlayer`), and
   any assertion that relied on the old lenient accept (e.g. accepting into a full roster
   — flip that assertion to expect the new throw).

### Verification — `scripts/trade-integrity-check.ts`
Disposable league (distinct name, exact-name cleanup), 3 teams, small caps (e.g.
ACTIVE cap 3, FARM 1) so overflow is easy to hit; roster via `commissionerAddPlayer`.
Assert:
1. Propose where the proposer would end up over cap → throws with the right N.
2. Propose a valid 1-for-1 → PROPOSED. Drop the proposer's player (as commissioner —
   he isn't locked yet, PROPOSED doesn't lock). Accept → throws "no longer valid".
3. Propose 2-for-1 into a full acceptor roster → accept throws "You must drop 1 player".
   Commissioner-drop one → accept succeeds → UNDER_REVIEW.
4. With that trade UNDER_REVIEW: `proposeTrade` including one of its players → throws
   locked; `dropPlayerFromRoster`, `sendToFarm`, `placeOnIR` (set `officialRosterStatus`
   to IR on the fixture first), `callUpToActive` (use a farm player in another accepted
   trade) → all throw locked; `setLineupSlot` on a locked player → **succeeds**;
   `commissionerDropPlayer` on a locked player → succeeds.
5. Before accepting a trade, create a second PROPOSED trade containing the same player;
   accept the first → the second is CANCELLED with a SUPERSEDED log row.
6. A FARM player with `waiverExpiresAt` in the future → `proposeTrade` throws "on waivers".
7. `computeTradeFit` on a hypothetical 3-for-0 into a roster at cap-1 → `overflow`
   reports `excess: 2` for ACTIVE on the receiving team, `fits: false`.
8. `getTeamNotifications` for a team blocking an expired UNDER_REVIEW trade contains the
   "drop N player(s)" item.
Then `npx tsx scripts/trades-check.ts` and `scripts/trade-review-check.ts` pass, `npx tsc
--noEmit`, `npm run build`. No browser check required for this task (no UI change) —
say so explicitly in the report rather than implying one happened.

---

## Task 1b — Trade hardening (loophole audit, backend)

Added after Task 1 shipped: a read-through of the whole trade module and everything it
touches, looking for ways a manager could gain an edge or grief another. Every item below
is a confirmed gap in the code as of commit `3fc0b77`, not a hypothetical. **Three
rules decisions were put to the user and are settled** (see "Decisions already made").
Backend only, like Task 1 — no browser check, say so in the report.

### The gaps, ranked
1. **Picks can be double-spent.** Task 1's lock covers PLAYER items only. The same
   `DraftPick` can sit in two accepted trades; both process, the second
   `draftPick.update({ currentOwnerId })` silently overwrites the first. Processing never
   re-checks pick ownership. Also, **used picks** (`usedOnPlayerId` set) are listed as
   tradeable — `getTradeableAssets` doesn't filter them and `assertOwnsAssets` doesn't
   reject them.
2. **Hostage trades.** After B accepts, A can fill their own roster so the trade never
   fits. It stays UNDER_REVIEW forever, managers can't cancel an accepted trade, and B's
   players are locked indefinitely. The only exit is the commissioner's force, which
   bypasses fit and overflows a roster.
3. **FAAB freeze by proposal.** `getAvailableBudget` subtracts FAAB the team is the
   *sending* side of in any PROPOSED or UNDER_REVIEW trade — including proposals the team
   hasn't agreed to. Anyone can propose "I want $100 of your FAAB" and freeze a rival's
   bidding until they notice and decline.
4. **Silent half-trades.** `executeTradeTransfers` does `if (!oldSlot) continue;` and
   marks the trade PROCESSED with whatever did move. Only reachable via a commissioner
   action now that locks exist, but it must fail loudly, not succeed quietly.
5. **Trade deadline only checked at propose.** Proposals made before the deadline can be
   accepted after it.
6. **Trades during a live draft** are allowed — nothing in `proposeTrade` or
   `respondToTrade` looks at draft state.
7. **Accept-time gaps:** no ORPHAN_FROZEN re-check for either team, no
   `draftPickTradingEnabled` re-check, and a same-instant double accept (two co-managers,
   or two trades sharing a player accepted concurrently) passes the lock check because
   neither is UNDER_REVIEW yet.
8. **FAAB items are tradeable in leagues with FAAB off.**
9. **Orphaning a team** (`leagues/mutations.ts` ~L191) leaves its in-flight trades
   alive; they'd process onto/off a frozen roster.

Not loopholes, verified: one-user-one-team is enforced on every join/claim/reassign path
(no self-dealing via co-manager); FAAB double-commit across bids and trades is handled;
the fit arithmetic is correct; veto threshold logic holds.

### Decisions already made (don't re-open)
- **Stuck trades: auto-cancel only.** A trade still UNDER_REVIEW and still not fitting
  **3 days after `reviewEndsAt`** is cancelled by the cron, both teams notified. No
  manual withdraw for the non-blocking side (user declined that option).
- **Keep the 24h post-trade demotion exemption** (`TRADE_EXEMPTION_WINDOW_MS` in
  `sendToFarm`). It enables a two-team waiver-laundering pattern (trade a veteran over,
  partner demotes him waiver-free, trades him back as a farm player); the user accepts
  that risk and relies on the veto. Document it in PROGRESS.md's Known gaps.
- **Full trade freeze during a live draft** — no proposals and no acceptances of any
  kind (players *or* picks) while any draft in the league is IN_PROGRESS.
- Governance note, not a code change: in COMMISSIONER veto mode a trade the commissioner
  is party to can't be vetoed by anyone unless a co-commissioner exists. Add to Known
  gaps so the user remembers when setting up the real league.

### Changes
1. **`src/lib/trades/locks.ts`** — add `getTradeLockedPickIds(leagueId, pickIds?)` and
   `assertPicksNotTradeLocked(leagueId, pickIds)` (PICK items in UNDER_REVIEW trades;
   message names the pick as "<season> Round <round>"). Still imports only `@/lib/db`.
2. **`src/lib/trades/mutations.ts`**
   - `getTradeableAssets`: picks filtered to `usedOnPlayerId: null`; each pick gains
     `lockedInTradeId: string | null`. `availableFaab` is `0` when `!settings.faabEnabled`.
   - `assertOwnsAssets`: pick count also requires `usedOnPlayerId: null`.
   - `proposeTrade`: `assertPicksNotTradeLocked` (both sides); throw if any FAAB item and
     `!settings.faabEnabled`; call `assertNoDraftInProgress(leagueId)` (below) first.
   - `respondToTrade` accept: `assertNoDraftInProgress`; re-check `tradeDeadline`
     ("This league's trade deadline has passed — this proposal can no longer be
     accepted."); re-check both teams not ORPHAN_FROZEN; re-check
     `draftPickTradingEnabled` when pick items exist; `assertPicksNotTradeLocked`.
     Convert the accept write to an **interactive** `$transaction(async (tx) => …)` that
     does `tx.trade.updateMany({ where: { id, state: "PROPOSED" }, data })` and throws
     `"This trade was already answered."` if `count !== 1` — closes the double-accept
     race without any new schema.
   - `executeTradeTransfers`: before any write, re-validate every item — PLAYER still
     owned by `fromTeamId`; PICK still `currentOwnerId === fromTeamId` and unused; FAAB
     `faabAmount <= fromBudget.remaining`. On any failure: set the trade `CANCELLED`, log
     `{ event: "INVALIDATED", reason: "<human sentence naming the item>" }`, return a new
     outcome `"INVALIDATED"` (extend `TradeExecutionOutcome`). Remove the `continue`.
   - `processDueTrades`: after the normal pass, find UNDER_REVIEW trades with
     `reviewEndsAt <= now - STUCK_TRADE_GRACE_MS` (`3 * 24h`, a named constant) whose
     `computeTradeFit` still fails → `CANCELLED`, log
     `{ event: "AUTO_CANCELLED", reason: "ROSTER_ROOM", blockingTeamIds: [...] }`. Include
     these in the cron's JSON result.
3. **`src/lib/draft/mutations.ts`** — export `assertNoDraftInProgress(leagueId)`: for each
   IN_PROGRESS draft call `resolveDraftState` first (same resolve-on-read as
   `getFreeAgencyStatus`), then throw `"Trades are paused while the draft is in progress."`
   if any is still IN_PROGRESS. Import direction `trades/mutations → draft/mutations` is
   safe (draft imports `leagues/mutations`, `rosters/ownership`, `players/rankings`; none
   import trades). Verify with grep before relying on it.
4. **`src/lib/faab/mutations.ts`** — `getAvailableBudget`: FAAB in a PROPOSED trade counts
   against a team only when **that team proposed it**; UNDER_REVIEW counts for either side.
   Prisma: `where: { fromTeamId: teamId, itemType: "FAAB", OR: [{ trade: { state: "UNDER_REVIEW" } }, { trade: { state: "PROPOSED", proposedByTeamId: teamId } }] }`.
5. **Orphaning cancels in-flight trades.** The orphan path lives in `leagues/mutations.ts`,
   which `trades/mutations.ts` imports — so don't import back. Do the cancellation one
   layer up: in the Server Action that orphans a team (find it under
   `src/app/leagues/[id]/settings/`), call `cancelTrade({ allowUnderReview: true })` for
   each PROPOSED/UNDER_REVIEW trade the team is party to, then orphan — same approach
   `leagues/season.ts` uses for `startNewSeason`.
6. **`src/lib/notifications/feed.ts`** — surface INVALIDATED / AUTO_CANCELLED / SUPERSEDED
   outcomes to both teams for 7 days: query `transactionLog` rows with `type: "TRADE"`
   and `payload.event` in those three (Postgres JSON path filter:
   `payload: { path: ["event"], equals: "AUTO_CANCELLED" }`, one query per event or an
   `OR`), joined back to the trade for team names. Text like
   `"Trade with X was cancelled — <reason>"`, kind `TRADE_RESULT` (new kind; add a dot
   colour in `NotificationsButton.tsx`).
7. **`PROGRESS.md` Known gaps**: the kept trade exemption + laundering pattern; the
   commissioner-veto governance note.

### Verification — `scripts/trade-hardening-check.ts`
Disposable league, 3 teams, small caps, `commissionerAddPlayer` for rosters, synthetic
`DraftPick` rows (see `scripts/trades-check.ts` for the fixture pattern). Assert:
1. Pick P in accepted trade T1 → proposing T2 with P throws locked; a used pick is
   absent from `getTradeableAssets` and rejected by `proposeTrade`.
2. Backdate T1 past its window, commissioner-move P to another team (`draftPick.update`
   directly — simulating the gap), run `processDueTrades` → T1 is `CANCELLED` with an
   INVALIDATED log naming the pick; nothing moved.
3. Rival proposes a trade asking for $50 of my FAAB → my `getAvailableBudget` is
   unchanged; once I accept (UNDER_REVIEW) it drops by $50.
4. Set `tradeDeadline` to yesterday after proposing → accept throws deadline.
5. Set up + start a draft → `proposeTrade` and `respondToTrade` both throw the pause
   message; complete the draft → both work.
6. Accept, backdate `reviewEndsAt` by 4 days with the acceptor's roster over cap →
   `processDueTrades` → `CANCELLED`, AUTO_CANCELLED log with `blockingTeamIds`, and
   `getTeamNotifications` for both teams contains the cancellation item.
7. Two concurrent `respondToTrade(accept)` calls (`Promise.allSettled`) → exactly one
   fulfils, the other rejects "already answered", trade UNDER_REVIEW once, one ACCEPTED log.
8. League with `faabEnabled: false` → `availableFaab === 0` and a FAAB item is rejected.
9. Orphan a team with a PROPOSED and an UNDER_REVIEW trade → both CANCELLED.
Then `scripts/trade-integrity-check.ts`, `trades-check.ts`, `trade-review-check.ts` still
pass; `npx tsc --noEmit`; `npm run build`.

---

## Task 2 — Trades page split, ESPN-style builder, confirm modal, redirect (issues #1, #2, #3)

### Goal (product)
- `/trades` becomes a short **list page**: Needs your response · Waiting on a response ·
  Under review. **History is removed entirely** (#2). A prominent "Propose Trade" button
  leads to the builder.
- `/trades/new` is the **builder**, laid out like the ESPN screenshot: the other team's
  full roster table first, a "↓ Select who to offer below" button that scrolls to *your*
  roster table, and a **sticky bottom bar**: `Receiving — <their team>` chips ·
  `Offering — <your team>` chips · `Continue` · `Cancel Trade`.
- `Continue` opens a **Confirm Trade modal** (Receiving list with → arrows, Offering list
  with ← arrows; headshot, name, NHL team · position; picks and FAAB as text lines) with
  one primary **Send Trade Proposal** button and a Back button. Nothing else in it — no
  comments, no expiry (user's call).
- After sending, the user lands on **their My Team page** with a one-time "Trade proposal
  sent to <team>." banner. No staying on the builder → no spam-sending.

### Changes
1. **`src/app/leagues/[id]/trades/page.tsx`** — strip the builder and the History section.
   Keep the header copy, the three lists (with Review / Withdraw / Veto / Force through
   exactly as today), and add `<LinkButton href="/leagues/[id]/trades/new" variant="primary">Propose Trade</LinkButton>`
   under the header (managers only). Remove the `counterFrom` handling from this page.
2. **`src/app/leagues/[id]/trades/new/page.tsx`** (new, server). `auth.protect()`; if the
   viewer has no team in the league, `redirect('/leagues/[id]/trades')`. Search params:
   - `with` — counterparty team id (default: first other team). Invalid → default.
   - `counterFrom` — same prefill logic that lives in `/trades` today (only trusted when
     the viewer's team was that trade's counterparty); moves here verbatim.
   - `give`, `receive` (comma-separated player ids), `givePicks`, `receivePicks`,
     `giveFaab`, `receiveFaab` — an optional saved selection. Parse and validate against
     the two teams' actual assets (drop unknown ids silently). Task 3 uses this to restore
     a draft after a detour; implement the parsing now so the builder has one initial-state
     path.
   Load `getTradeableAssets` for **only the two teams** (not every team — switching
   counterparty navigates to `?with=<id>`, which is simpler and lighter than shipping every
   roster to the client), plus `getPlayerStatsAggregate` for both rosters with the
   league's `scoringConfig`. Render `<TradeBuilder>`.
3. **`TradeBuilder.tsx`** — rewrite (client). Structure top to bottom:
   - "Trade with" `<select>` → `router.push('/trades/new?with=<id>')` (selection resets;
     that's fine and matches ESPN).
   - **Their roster** — new `TradeRosterTable` component: two tables (Skaters with
     `SKATER_COLUMNS + POINTS_COLUMNS`, Goalies with `GOALIE_COLUMNS + POINTS_COLUMNS`,
     same as the team page), rows: checkbox · headshot · name · `NHL · pos` · a `Badge`
     for tier when not Active (`Farm` / `IR`) · stat cells. Rows with `lockedInTradeId`
     or `onWaiversUntil`: checkbox disabled, badge `Pending trade` / `On waivers`, `title`
     explaining. Below the tables, a compact row for that team's draft picks (checkboxes)
     and FAAB (number input) — keep the mechanism; ESPN just doesn't have it.
   - `↓ Select who to offer below` button (`secondary`) → `ref.scrollIntoView({ behavior: "smooth" })`.
   - **Your roster** — same component.
   - **Sticky bottom bar** — `sticky bottom-0` inside the page, `bg-surface border-t border-border shadow`,
     three regions. Chips = `PlayerHeadshot` 24px + last name (or "R2 2027" / "$15 FAAB").
     `Continue` (`primary`, disabled until at least one asset is selected on either side),
     `Cancel Trade` (`secondary`, clears both selections).
   - **Confirm modal** — `Modal` titled "Confirm Trade". On **Send Trade Proposal**, call
     `proposeTradeAction` imperatively (not via `<form action>`) so a thrown validation
     error (locked player, overflow, deadline…) renders inside the modal in red instead of
     bubbling to the route error boundary. Disable the button while pending.
   - Delete the old two-step `step: "select" | "review"` flow and `AssetChecklist`.
4. **`TradeAssetSummary.tsx`** — `PlayerStatLine` and `TradeAssetSummary` remain for the
   review page; the builder no longer uses them. Delete anything that ends up unused (grep).
5. **`actions.ts`**:
   - `proposeTradeAction` now returns `{ ok: true; redirectTo: string } | { ok: false; error: string }`
     instead of relying on `<form action>` + revalidate. On success `redirectTo =
     /leagues/[id]/teams/[proposingTeamId]?sent=<counterpartyTeamId>`; the client does
     `router.push(redirectTo)`. Still `revalidatePath` both `/trades` and the two team pages.
   - `counterTradeAction` redirects to `/leagues/[id]/trades/new?counterFrom=<id>`.
6. **Team page** (`teams/[teamId]/page.tsx`): read `?sent=<teamId>`; when present and the
   viewer manages this team, render a small success `Card` at the top: "Trade proposal
   sent to <team name>." (look the name up; ignore unknown ids). It disappears on the next
   navigation — no state needed.
   Also: when the viewer is **not** this team's manager but does manage another team in
   the league, show `Propose Trade` → `/trades/new?with=<thisTeamId>` in the header's
   right-hand slot (where managers see the Notifications button). Needs one extra lookup:
   `prisma.team.findFirst({ where: { leagueId, ...managerOrCoManagerWhere(userId) } })`.
7. Update the `Trades` entry in `src/components/LeagueNav.tsx` only if its href needs to
   change (it doesn't — `/trades` still exists). The team-page action bar's
   `Propose Trade` should now point at `/trades/new`.

### Decisions already made
- Two routes (`/trades` list, `/trades/new` builder) rather than one long page — a sticky
  action bar over a list of unrelated pending trades would be wrong, and "Propose Trade"
  should land straight in the builder.
- Only the two involved rosters are loaded per builder view; changing counterparty is a
  navigation.
- The review page (`[tradeId]/review`) keeps its current two-card layout; not in scope.
- Builder width: `max-w-6xl` like the Players page (the roster tables need it). List
  page stays `max-w-3xl`.

### Verification
Disposable league, 3 teams, rostered via `commissionerAddPlayer` or a scripted draft;
`// TEMP:` bypass for `layout.tsx` + the page + any Server Action you exercise. Browser:
`/trades` shows the three lists and no History; `Propose Trade` lands on `/trades/new`;
their roster renders first with real stat columns; the scroll button reaches your roster;
selecting on both sides populates the sticky bar; `Cancel Trade` clears it; `Continue`
opens the modal with correct Receiving/Offering; `Send Trade Proposal` lands on your team
page with the "sent to X" banner; `/trades` then lists it under Waiting on a response; the
counterparty's `/trades` lists it under Needs your response; `Counter` from the review page
opens `/trades/new?counterFrom=` prefilled and swapped. Also: pick a locked player scenario
(accept a trade first) and confirm the row is disabled with the badge. Screenshot the
builder with the sticky bar populated, and the confirm modal. `npx tsc --noEmit`,
`npm run build`, exact-name cleanup, `grep -rn "TEMP:" src/` clean.

---

## Task 3 — Roster-fit UX and locked-player UI (issues #4, #5 — the parts the user sees)

### Goal (product)
- **On send:** clicking `Continue` first checks whether *your* roster would overflow with
  the incoming players. If it would, instead of the confirm modal you get: "This trade
  would leave you N over your Active roster cap. Drop N player(s) first, or add more of
  your players to the offer." with `Adjust trade` and `Go drop players →`. The latter
  takes you to My Team **with drop mode already on**; when you're done there's a
  "Return to trade builder →" link that restores your selection.
- **On accept:** clicking `Accept` on a trade that doesn't fit your roster shows "You must
  drop N player(s) in order for this trade to go through." with `Go to my team →` — same
  drop-mode team page, now with a banner counting down "Drop N more player(s) to accept
  the trade with X", turning into "Roster has room — Back to trade →" at zero.
- **Locked players** are visibly marked everywhere (`Pending trade` badge) and their
  drop / farm / IR / call-up controls are disabled on the team page.

### Changes
1. **`actions.ts`** — `checkTradeFitAction(leagueId, proposingTeamId, counterpartyTeamId, give, receive): Promise<TradeFit>`
   (auth-protected read; uses `buildProposalItems` + `computeTradeFit` from Task 1).
2. **`TradeBuilder.tsx`** — `Continue` calls `checkTradeFitAction` first. If the
   proposer's team appears in `overflow` → open the **Roster too full** modal variant
   (message as above, worst tier first). `Go drop players →` builds the current builder
   URL with the full selection encoded in the Task 2 params and navigates to
   `/leagues/[id]/teams/[myTeamId]?dropMode=1&returnTo=<encodeURIComponent(thatUrl)>`.
   If the proposer fits → the normal confirm modal; if the *counterparty* overflows, add a
   muted info line in the confirm modal: "<Team> will need to drop N player(s) to accept."
   `proposeTrade` still enforces server-side (Task 1) — the modal is UX, not the guard.
3. **Review page** — compute `computeTradeFit` server-side; pass the acceptor's overflow
   (if any) into a new client `AcceptTradeControls.tsx` that owns the Accept / Decline /
   Counter buttons. Accept with overflow → `Modal` "You must drop N player(s) in order for
   this trade to go through." + `Go to my team →` →
   `/leagues/[id]/teams/[myTeamId]?dropMode=1&pendingTrade=<tradeId>`. Accept without
   overflow → submits as today. Decline / Counter unchanged.
4. **Team page** (`teams/[teamId]/page.tsx` + `RosterMoveBoard.tsx`):
   - Read `dropMode`, `returnTo`, `pendingTrade`. `RosterMoveBoard` gains
     `initialDropMode?: boolean` (seeds the existing `dropMode` state).
   - `returnTo`: only honour values starting with `/leagues/${leagueId}/trades/new`
     (no open redirect). Render a `Card` banner above the action bar: "You're making room
     for a trade. **Return to trade builder →**".
   - `pendingTrade`: load the trade (`getTradeDetailById`), confirm this team is a party,
     run `computeTradeFit`; banner: "Drop **N** more player(s) to accept the trade with X"
     while N > 0, else "Roster has room — **Back to trade →**" linking to the review page.
     Ignore unknown/non-party trade ids silently.
   - Locked players: `getTradeLockedPlayerIds(leagueId, activePlayerIds)`; on locked rows
     add `Badge` `Pending trade` (tone `navy`), set `canDrop: false` and
     `canSendToFarm: false` on the `MoveBoardRow`, and skip the `IR_PLACE` destination.
     Farm list: `↑ Call Up` disabled with `title="Locked in a pending trade"`. IR list:
     activation disabled with the same reason. (Lineup `Move` stays enabled — confirmed.)
5. **Builder** already disables locked rows (Task 2) — nothing more here.

### Decisions already made
- The pre-flight fit check on `Continue` is UX only; the server-side guard in
  `proposeTrade` / `respondToTrade` from Task 1 is the real enforcement.
- Drop mode is entered via a URL param so a link (from a modal, a notification, or the
  banner) can open it directly; the existing toggle keeps working.
- "Return to trade builder" restores the selection via URL params — no server-side draft
  storage.

### Verification
Same disposable-league approach. Browser, as the proposer: build a 2-for-0 into your
full roster → `Continue` → the Roster-too-full modal with N=2 → `Go drop players` → My Team
opens in drop mode with the return banner → drop two → `Return to trade builder` restores
the counterparty and both selections → `Continue` now opens the confirm modal → send.
As the acceptor (second `// TEMP:` userId): review page → `Accept` on a trade that
overflows → modal with the right N → `Go to my team` → banner counts down as you drop →
"Back to trade" → Accept succeeds → trade UNDER_REVIEW. Then on the team page confirm the
traded players show `Pending trade`, their Drop/Farm controls are gone, and `Move` still
works. Screenshots of both modals and the countdown banner. `npx tsc --noEmit`,
`npm run build`, exact-name cleanup, `grep -rn "TEMP:" src/` clean.

---

## Out of scope: issue #6 (commissioner pushes trades through)

Already exists as `forceProcessTrade` / the "Force through now" button on under-review
trades: commissioner-only, skips the remaining review window **and** the roster-fit check.
Two deliberate limits: it only applies to trades the counterparty has already accepted
(UNDER_REVIEW, not PROPOSED), and a commissioner can't force a trade they're a party to
(conflict-of-interest rule, same as veto). The user chose to leave any change to this for
the upcoming commissioner-tools redesign — don't extend it here, but do document its
current shape in PROGRESS.md if you touch that section.

## Checklist

- [x] Task 1 — trade integrity backend (#4/#5)
- [x] Task 1b — trade hardening (loophole audit)
- [x] Task 2 — page split + ESPN builder + confirm modal + redirect (#1/#2/#3)
- [ ] Task 3 — fit UX + locked-player UI (#4/#5)
