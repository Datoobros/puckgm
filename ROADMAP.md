# Build Roadmap — Aug 2026 → Sept 2027

**Launch target:** 2027–28 season, late September 2027
**2026–27 is the testing season** — the build runs alongside a live NHL season, which is
the single biggest advantage this schedule has.

Every milestone below has an explicit **"how you know it worked."** A milestone without a
passing test is not done, regardless of how much code exists.

---

## Calendar anchors

| Date | Event |
|---|---|
| **Aug 9, 2026** | Today. ~7 weeks to puck drop. |
| **Late Sept 2026** | 2026–27 season opens (84 games this year, expanded from 82) |
| **Late Nov 2026** | ~30 games in — enough sample to trust a validation diff |
| **Mar 2027** | Real NHL trade deadline |
| **Mid-Apr 2027** | Regular season ends |
| **Late Jun 2027** | Stanley Cup + **NHL Entry Draft** — new prospect class enters the pool |
| **Jul 1, 2027** | NHL free agency opens |
| **Late Sept 2027** | **2027–28 season — launch** |

---

## Stage 1 — Data + scoring engine
**Aug 9 → Sept 27, 2026 (7 weeks). Hard deadline: opening night.**

This is the only stage with a real deadline, because its validation requires a live season
to elapse. Miss opening night and you lose a month of test data you cannot recreate.

### Week 1–2 (Aug 9–23) — Data spike
Prove the assumptions before building on them.

- Confirm NHL endpoints return: game boxscores, player game logs, career GP, official
  roster status (IR/LTIR), org affiliation, draft results
- **Verify the prospect assumption** — does NHL's player landing endpoint actually carry
  non-NHL season totals (OHL / WHL / NCAA / SHL)? The entire "free prospect data" plan
  rests on this. If it fails, decide now whether to pay for Elite Prospects or ship
  prospects as name-and-org-only.
- Build the player identity layer: internal IDs + source mapping table

> **Test:** pick 10 players spanning an NHL star, an AHL callup, a CHL prospect, a college
> kid, and a European. Resolve each to a stable internal ID and pull their full profile.
> If any category fails, that's a scoping decision, not a bug to grind on.

### Week 3–4 (Aug 24 – Sept 6) — Stat ingestion
- Game-level stat line ingestion, stored raw (never pre-computed points)
- **Backfill the entire 2025–26 season** as a fixed test corpus
- Idempotent re-ingestion — re-running a day must not duplicate or corrupt

> **Test:** ingest all of 2025–26, then re-ingest it. Row counts identical, no duplicates.
> Spot-check 20 random box scores against NHL.com by hand.

### Week 5–6 (Sept 7–20) — Scoring engine
- H2H Points scoring, driven by a config of `statId → point value`
- Config shaped to mirror ESPN's model so a real league's settings can be imported
- Recompute-on-read, so retroactive stat corrections flow through automatically

> **Test:** configure ESPN's default 12-cat H2H Points values (G=2, A=1, PPP=0.5, SOG=0.1,
> W=4, SV=0.2, plus +/-, HIT, BLK, SHP, GA, SO). Run the full 2025–26 season through it.
> Compare your season point totals for the top 100 skaters and top 30 goalies against
> ESPN's published totals. **Target: exact match.** Every discrepancy is either a bug or a
> rule you misunderstood — both are worth more now than in a live dynasty.

### Week 7 (Sept 21–27) — Live pipeline + monitoring
- Scheduled daily ingestion
- Alerting when a day's ingest fails or returns suspicious counts
- A dashboard showing yesterday's games, stat lines pulled, points computed

> **Test:** run it against preseason games. Survive a full week unattended.

### ✅ Stage 1 milestone — opening night, late Sept
**Live games ingest automatically and produce correct fantasy point totals with no manual
intervention.** No league, no rosters, no UI beyond a debug view.

---

## Stage 2 — Shadow validation *(runs continuously, Oct 2026 → Apr 2027)*

Not a build stage — a background process that runs all season while you build everything
else. This is what the testing season is *for*.

- Create a real ESPN fantasy hockey league (free) and mirror its exact settings in your app
- Every day, diff your computed totals against ESPN's for every rostered player
- Log every disagreement with the game and stat that caused it

**What you're actually hunting:** postponements, doubleheaders, stat corrections days after
the fact, players traded mid-season, goalies credited with weird stat lines, emergency
backup goaltenders, shootout handling, and the 84-game schedule's unfamiliar quirks. None
of these show up in a backfill test. All of them will break something.

> **Checkpoint — late Nov 2026 (~30 games in):** 30 consecutive days of zero unexplained
> diffs. If you're still finding new failure modes at Thanksgiving, the pipeline isn't
> ready and everything downstream slips. **This is the gate that matters most in the whole
> plan.**

---

## Stage 3 — Leagues, rosters, lineups
**Oct → Dec 2026**

- League creation with settings, including the mutability tiers
- **Roster composition set by the LM at creation, immutable thereafter**
- Active rosters; **pre-set-a-week-ahead lineups, freely editable, per-game lock only**
- IR slots with the 48h activation deadline
- Matchup periods and H2H Points scoring against an opponent

> **Test:** run a solo shadow team. Pre-set a full week of lineups, then edit mid-week and
> confirm the changes take. Verify a player locks the moment his own game starts and not
> before. Confirm IR activation fires on real NHL transactions, and that weekly matchup
> totals reconcile against your Stage 2 shadow numbers.

---

## Stage 4 — Transactions
**Jan → Feb 2027**

- FAAB: blind bids, daily processing, budget tracking
- The wire: unowned player pool
- Trades with the review window, plus LM veto / vote
- Tradeable draft picks and tradeable FAAB

> **Test:** the **mock league** — recruit 3–5 friends and run a fake league against live
> January hockey. No stakes, no dynasty. You're not testing whether the code runs; you're
> testing whether the *rules* survive contact with people trying to win. Every rules
> argument you have in February is one you don't have in a real dynasty in 2028.

---

## Stage 5 — Dynasty layer
**Feb → Apr 2027**

- Farm slots and roster tiers
- Demotion waivers with the 80-GP exemption
- Callups with the per-week limit
- Orphan team takeover: frozen roster state
- Season rollover state machine

> **Test:** keep the mock league running through the real trade deadline and into April.
> Deliberately try to break your own rules — stash a star in the farm, leave a healthy
> player on IR, burn callups at a week boundary. Every exploit you find is one your league
> would have found for you.

> **Test:** run the rollover against the real end of the 2026–27 season in April. It should
> close out cleanly and produce a valid offseason state.

---

## Stage 6 — Draft
**Apr → Jun 2027**

- Weighted lottery by reverse standings
- Draft room: live picks, timer, queue, autopick
- Pick conveyance — traded picks land with the right owner
- Annual draft class ingestion

> **Test — the real one:** the **NHL Entry Draft happens in late June 2027.** Ingest that
> real class the day it happens and confirm every drafted player appears correctly in your
> pool with the right org. This is a live fire drill you get exactly once before launch.

> **Test:** run a full mock startup draft with your friends. Draft rooms fail in ways
> nothing else does — disconnects, timer edge cases, simultaneous picks.

---

## Stage 7 — Launch prep
**Jul → Sept 2027**

- July 1 free agency: confirm the pool updates as real signings land
- Real league creation, settings ratified by your league
- **Startup draft — Aug/Sept 2027**
- Buffer for everything that goes wrong

> **Test:** the startup draft *is* the test. If it completes and 12 rosters are valid, you
> launch.

### 🏁 Launch — late Sept 2027

---

## Deliberately not on this roadmap

- **Contracts** — see DESIGN.md §2.12. Post-launch at the earliest.
- **Mobile app** — web first, responsive.
- **Public/multi-league hosting** — this is a private league. Anything else changes the
  ToS picture around undocumented APIs.

---

## How this plan can fail

**The one deadline that's real is opening night.** Everything else has slack; Stage 1 does
not. If the pipeline isn't live in late September, you lose irreplaceable validation time
and every later stage compresses.

**The gate that decides the year is the November checkpoint.** If diffs are still noisy 30
games in, stop building features and fix the pipeline. A dynasty league running on scoring
you don't trust is worse than no league.

**The most likely real-world failure is the mock league not happening.** Stage 4 and 5
tests both depend on getting 3–5 friends to play something unfinished. Line those people
up in December, not February.
