# Fantasy Hockey GM Sim — Design Spec

**Status:** design draft, pre-implementation
**Target:** private league play, 2027–28 season
**2026–27 is a testing season** — no live league, used to validate data and scoring

---

## 1. What this is

A dynasty fantasy hockey league that simulates running an NHL front office, not just
picking a lineup. The distinguishing features vs. ESPN/Yahoo:

- **Persistent dynasty rosters** carried year over year
- **A farm system** holding drafted prospects until they're NHL-ready
- **Draft picks as tradeable assets**, with a weighted lottery
- **Waiver risk** on demoting established players
- **FAAB** as the in-season acquisition currency

The design goal that settles arguments: *when a rule is ambiguous, pick the option that
makes the manager feel more like a GM making a real decision with real cost.*

---

## 2. Locked decisions

These are settled. Rationale is recorded because each one exists to prevent a specific
failure, and they'll be tempting to undo later.

### 2.1 Player pool

Draftable/rosterable = **any player tied to an NHL organization**: under NHL contract,
or drafted by an NHL club (including unsigned prospects in CHL / NCAA / Europe).

> **Why it matters:** this rule means every eligible player already exists in NHL's own
> free data. Undrafted amateurs would have required a paid Elite Prospects key. The pool
> refreshes annually when the real NHL draft happens in late June.

### 2.2 Farm system

- Holds drafted prospects and a limited number of NHL players
- Farm players **do not score** for your team
- **Limited slots** — creates a forced trade-or-promote squeeze over time
- Prospect stat display: **season totals only**, sourced free from NHL's player endpoint
  (e.g. "OHL: 34 GP, 51 P"). Not live, not game-by-game.
- FAAB pickups **may go directly to the farm**

### 2.3 Farm eligibility / demotion waivers

**A player with fewer than 80 career NHL games is waiver-exempt.** At 80+, demoting him to
the farm exposes him to claims by other teams.

> **Why games played, not age:** an age cutoff (e.g. under 26) would exempt Bedard,
> Celebrini, Michkov, and both Hughes brothers in 2026–27 — precisely the players most
> worth hoarding. Games played tracks *has this player arrived yet*, which is the actual
> question. This mirrors real NHL waiver-exemption logic.

Waiver claim priority: **reverse standings**, updated weekly.

### 2.4 Scoring and lineups

**Scoring format: H2H Points.** Weekly head-to-head, most total points wins the matchup.
Point values per stat are league-configurable; ESPN's default 12-cat set is the starting
point (G=2, A=1, PPP=0.5, SOG=0.1, W=4, SV=0.2, plus +/-, HIT, BLK, SHP, GA, SO).

**Active roster composition** (C / LW / RW / D / G / UTIL / bench counts) is **set by the
league manager at creation and cannot be changed afterward.**

> **Why immutable:** roster shape is the single biggest driver of positional value. Going
> from 2 G to 3 G mid-dynasty would instantly reprice every goalie in the league, including
> ones people traded picks to get.

**Lineups: pre-set, freely editable. No lock, no caps.**

- You can set lineups for the entire upcoming week in advance
- You may change any day, at any time, right up until a player's game starts
- **Per-game lock only** — a player locks when his own game begins, nothing else
- **No limit on lineup edits** per week
- **No games-played cap** per position per matchup period

> **Why no games-played cap is safe here but wouldn't be on ESPN:** ESPN needs a cap
> because add/drops are nearly free there, so an attentive manager can churn the wire
> nightly for volume. In this design every acquisition already costs something real —
> FAAB is finite, callups are capped per week, and active roster size is fixed. The
> economy does the work a cap would do.

> **The honest tradeoff:** a manager who optimizes nightly around the schedule will still
> out-earn one who sets a week and walks away, because he'll field a full lineup more
> often. That gap is skill, not grind — he isn't acquiring anything, just reading the
> schedule better. Accepted deliberately.

> **The differentiator:** ESPN forces you into the app every single day. Here you set a
> week ahead and only intervene when something needs attention. Same control, far less
> grind. The convenience is the product, not a weaker ruleset.

### 2.5 Callups

- Limited number per matchup period (per week)
- Injury status is **not** a precondition — callups are freely chosen, constrained by the
  per-week limit

> **Why not gate on injuries:** NHL injury *prognosis* data is deliberately vague
> ("upper-body," day-to-day indefinitely) and unreliable. Never make unreliable data
> load-bearing for a rule. See §2.6 for the reliable half of injury data.

> **Why the limit still exists without a lineup lock:** with daily edits, an unlimited
> callup right turns the farm into a streaming carousel — call up whoever has four games
> this week, send him down, repeat. The weekly cap keeps the farm a place for assets you're
> developing rather than a rotating bench.

**Mechanics.** Two layers that are easy to conflate:

- **Roster** — who you own and where: `ACTIVE` / `FARM` / `IR`
- **Lineup** — who plays and scores tonight, drawn from your active roster

A callup is simply moving a player `FARM → ACTIVE`. It is legal only if an active slot is
open; *how* you opened it (IR placement, send-down, drop) is your business. There is no
special "swap" transaction.

| Question | Answer |
|---|---|
| Is a callup a 1-for-1 swap? | No — it's "move to ACTIVE," gated by roster limits |
| Can he play immediately? | Yes, as soon as he's on the active roster and his game hasn't started |
| When does the limit reset? | At matchup period start |
| Does the send-down cost a callup? | No. Only callups count. Send-downs are already priced by demotion waivers (§2.3) |

**Worked example** — active 18/18, farm 5/6, callup limit 2/week:

1. **Tuesday:** your starting center is officially placed on IR by his NHL club.
2. You move him `ACTIVE → IR`. Roster 17/18 — a slot opens.
3. You call up a prospect `FARM → ACTIVE`. Roster 18/18, farm 4/6. **1 of 2 callups used.**
4. He takes the vacated lineup spot and scores from Wednesday on.
5. **Two weeks later:** his NHL club activates him. Within 48h you must move him off IR —
   but active is 18/18, so the move is **blocked** until you make room. You send the
   prospect down (free — under 80 GP).

### 2.6 Injured reserve

- IR slot count is **configurable per league**
- IR eligibility gates on **official NHL roster status** (placed on IR / LTIR), never on
  injury severity or projected return

> **The distinction that makes this safe:** *whether a player was placed on IR* is a real,
> reliably reported transaction. *What's wrong with him and when he's back* is not. Gate
> on the former only.

- **Activation deadline:** when a player's official status clears, he must be activated
  within ~48h or the system force-activates. If the active roster is full, the move is
  blocked until the manager makes room.

> **Why:** the real IR exploit is not un-stashing. Without a deadline, IR silently becomes
> extra bench. The forced squeeze is intended — it's what a real GM faces coming off LTIR.

### 2.7 Free agency

**FAAB** (Free Agent Acquisition Budget), blind bid.

> **Why FAAB over rolling priority:** it's the same muscle as the eventual contracts
> feature — finite money against competing needs and future flexibility. Build it now and
> contracts becomes an extension rather than a bolt-on. It also makes the tradeoff real:
> a hot goalie in November costs you the deadline pickup in March.

- **Daily processing** (~4am ET) — hockey locks daily; weekly is far too slow
- $0 bids allowed, so unclaimed players stay effectively free
- Budget resets each season
- **FAAB is tradeable** ("my 2029 3rd for $30 of your budget")

### 2.8 Draft

- **Year 1:** startup draft, full pool
- **Subsequent years:** draft prioritizes newly NHL-affiliated young talent. Dropped
  veterans do **not** re-enter the draft — they go to the free agent pool and are
  available via FAAB at any time.
- **Order: weighted lottery by reverse standings**, mirroring the real NHL. Bad teams get
  better odds, not guarantees.
- **Picks are first-class tradeable objects** — "2029 2nd, originally Dave's" is a row you
  can move, not a derived ordering.

### 2.9 Terminology

Two unrelated systems, deliberately named apart. Both exist in real hockey; fantasy
platforms confusingly call both "waivers."

| Term | Meaning | Trigger |
|---|---|---|
| **Demotion waivers** | Sending an 80+ GP player to the farm exposes him to claims | You demote |
| **The wire** | Picking up an unowned player via FAAB | You want someone unrostered |

### 2.10 League settings mutability

Configurable settings need tiers. **Principle: anything that changes asset value cannot
change mid-season.**

| Tier | Settings | Who / when |
|---|---|---|
| **Locked at creation** | League size, scoring format, **active roster composition** | Never changes |
| **Between seasons, by vote** | Farm slots, IR slots, roster size, scoring values, 80-GP threshold, FAAB budget | League vote, offseason only |
| **Anytime** | Trade deadline date, FAAB processing time, cosmetics | LM alone |

> **Why:** if a league votes in year 3 to cut farm slots 8 → 6, it retroactively destroys
> the value of prospects people traded first-round picks to acquire. Cheap now (a
> mutability flag per settings field), miserable to retrofit after someone's been burned.

### 2.11 League health

**Trade review window.** Trades are visible for 24–48h before processing, with LM veto or
a league vote threshold.

> **Why:** in redraft, a lopsided trade costs one season. In dynasty, a checked-out manager
> dumping assets to a friend poisons the league for years.

**Orphan teams.** An abandoned team enters a takeover state: **roster frozen, no trades**,
until a replacement manager is seated.

> **Why:** this is a decade-long league. People will quit. An abandoned roster of elite
> prospects either rots or gets picked clean. This is a product feature with real UI, not
> just a rule.

### 2.12 Deferred

**Contracts.** Signing players against a cap using real NHL contract data — explicitly a
later phase, possibly never.

Two reasons it waits:
1. **Design:** inheriting real cap hits verbatim means real GMs decide your fate. Draft a
   kid on an ELC, he signs for $14M in real life, your cap implodes and you made no
   decision. If built, use real cap hits as a *price signal* and let managers choose term
   and dollars.
2. **Data:** CapFriendly was the source and it's gone — Washington bought it in June 2024
   and took it private. PuckPedia is the successor but it's a website, not an API. This
   means scraping or manual seeding. (Reference: 2026–27 cap is $104M, max player $20.8M.)

---

## 3. Still open

Genuinely undecided. Listed rather than silently invented — several are fundamental.

### Fundamental

- **League size** — 12 assumed throughout, unconfirmed. Not blocking; affects tuning only.

### Tuning
- **Farm slot count** — suggest 6–8. With 2–3 prospects drafted per year, that forces a
  real decision roughly every two years. Start tight; loosening later is painless,
  tightening mid-dynasty means telling people to cut assets they earned.
- Callups per week
- FAAB budget size ($100 / $200)
- Lottery odds table, and how many picks are lotteried (real NHL does top 2)
- Trade review window length; veto vs. vote threshold
- Matchup period count (note: **2026–27 NHL season is 84 games**, expanded from 82)

---

## 4. Data model

### 4.1 Three non-negotiables

**Internal player IDs with a source mapping table.** Never key off a vendor's ID. A
prospect's CHL → AHL → NHL journey crosses sources that don't share identifiers.

```
players            (id, full_name, dob, primary_position, shoots, ...)
player_source_ids  (player_id, source, source_id)   -- 'nhl', 'espn', 'eliteprospects'
```

**Append-only transaction log.** Every roster move, trade, claim, bid, and draft pick
conveyance is an immutable row. Dynasty means answering "why does this team own this pick"
three years later. It also makes orphan takeover and dispute resolution possible at all.

```
transactions (id, league_id, type, actor_team_id, payload, effective_at, created_at)
```

**Store raw stats; compute fantasy points on read.** Never persist computed point totals as
the source of truth.

> **Why this specifically:** NHL stats get corrected retroactively — official scorers
> reassign assists days after a game. If you baked the fantasy points in, a correction
> silently desyncs your history from reality. Store immutable game-level stat lines and
> recompute against the league's scoring config.

```
game_stat_lines (player_id, game_id, game_date, stats_json)
```

### 4.2 Core tables

```
leagues              (id, name, season_founded, settings_json, ...)
league_settings_log  (league_id, field, old_value, new_value, changed_at, changed_by)
teams                (id, league_id, name, manager_user_id, state)
                       state: ACTIVE | ORPHAN_FROZEN

roster_slots         (team_id, player_id, slot_type, effective_from, effective_to)
                       slot_type: ACTIVE | FARM | IR

draft_picks          (id, league_id, season, round, original_team_id, current_owner_id,
                      lottery_result, used_on_player_id)
trades               (id, league_id, proposed_at, review_ends_at, state)
trade_items          (trade_id, from_team_id, to_team_id, item_type, item_ref)
                       item_type: PLAYER | PICK | FAAB

faab_budgets         (team_id, season, starting_amount, remaining)
fa_bids              (team_id, player_id, amount, target_slot, process_date, result)
waiver_claims        (team_id, player_id, priority_at_claim, result)

matchup_periods      (league_id, season, period_no, start_date, end_date)
lineups              (team_id, game_date, player_id, lineup_slot)
```

### 4.3 Derived player state

Recomputed from NHL data, not hand-maintained:

- `career_nhl_gp` → drives the 80-GP waiver-exemption flag
- `current_nhl_org` → drives player-pool eligibility
- `official_roster_status` → drives IR eligibility and the activation deadline

---

## 5. Roadmap

The 2026–27 season starts in ~50 days. It is a **testing season** — which is exactly the
right use for it.

### Phase 0 — Data + scoring, in shadow mode *(start now, runs all season)*
Build the ingestion pipeline, player identity layer, and scoring engine. Run it against
the live 2026–27 season with no league attached.

This front-loads the two things that take a full season to validate and can't be rushed
later:
1. **Does the pipeline survive 84 games?** Postponements, corrections, roster churn,
   schedule quirks, API changes.
2. **Is the scoring math right?** Mirror a real ESPN league's settings and diff your
   computed totals against theirs. Any disagreement is a bug in your engine or your
   understanding — both worth finding now.

Everything after this is application logic you can build against known-good data.

### Phase 1 — Leagues and rosters
League creation, settings with mutability tiers, active rosters, daily lineups and locks,
IR slots with the activation deadline.

### Phase 2 — Transactions
FAAB with daily processing, the wire, trades with review window, tradeable picks and FAAB.

### Phase 3 — Dynasty layer
Farm slots, demotion waivers with the 80-GP rule, callups, season rollover state machine,
orphan takeover.

### Phase 4 — Draft
Startup draft, weighted lottery, annual draft with pick conveyance.

### Phase 5 — Contracts *(maybe, see §2.12)*

Order is by **risk and lead time**, not by user-facing sequence. Phase 0 is first because
it's the only phase whose validation requires a real season to elapse.

---

## 6. Principal risks

| Risk | Notes |
|---|---|
| **Scope** | Dynasty + farm + draft + waivers + FAAB is a GM game, not a fantasy app. Phasing exists to keep this honest. |
| **Undocumented APIs** | NHL and ESPN endpoints are unofficial and can change without notice. Fine for private play; a real problem if this ever goes public. |
| **ToS** | Using ESPN's undocumented API is a gray area for anything beyond personal use. |
| **Prospect stat coverage** | **Verified (Aug 2026 spike).** `api-web.nhle.com/v1/player/{id}/landing` returns full season totals (GP/G/A/P/PIM/+/-) tagged by `leagueAbbrev` for NCAA, OHL, USHL, AHL, etc., free and unauthenticated, going back through youth hockey. Confirmed live on a not-yet-NHL-debuted prospect (Cole Eiserman, NYI 2024 pick). No paid API needed for this. |
| **No official IR/LTIR endpoint found** | Roster and landing payloads don't expose injury/roster-move status. §2.6's IR design still holds (gate on status, not prognosis) but the status itself likely has to come from ESPN's transactions feed or a scrape, not NHL's API directly. **Resolve in Stage 1 week 1.** |
| **`api-web.nhle.com` blocks naive fetchers** | A bare HTTP fetch (no browser-like headers) returned 403. Confirm your production stack's HTTP client works against it before building the pipeline around it. |
| **Dynasty schema permanence** | Year-1 modeling mistakes are permanent once real transaction history accrues. §4.1 exists for this reason. |
