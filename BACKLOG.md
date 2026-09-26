# Backlog — requested changes not yet built

Running list of things the user wants changed or added, captured as-is until there's enough
detail to plan and build. When an item ships, move it off this list and document it in
`PROGRESS.md` the way every other feature is — this file is just the queue, not the record.

## Open

- **Live in-game stat tracking** — planned in `plans/live-tracking-batch.md` (6 tasks).
  Priority #1 per the user. Scores currently freeze at ~5am ET for 24h. Verified against
  real live games: the NHL boxscore is fully populated mid-game and ~20s fresh, so this is
  buildable. Decisions confirmed: 60s polling, live points folded into the score with a LIVE
  badge, display-only (results and standings settle on finalized data). Task 1 is a shared
  NHL request pacer that also fixes the rate-limit fallout from ingest-reliability Task 4b.
  Needs no Vercel plan upgrade — an external scheduler drives it free.

- **Ingest reliability + stat coverage** — planned in `plans/ingest-reliability-batch.md`
  (7 tasks). The daily ingest cron has never ingested a real game (this project started
  after the 2025-26 season ended; all 52,478 stat lines came from the backfill script), and
  the 2026-27 season starts 2026-09-29. Tasks 1–4 must land before then: retry/backoff in
  the NHL client, a cron route that can't be aborted by one failing phase, a 3-day
  heal-forward window plus a visible `IngestRun` record, and a full-slate dress rehearsal
  against the 60s function budget. Tasks 5–7 follow: NHL playoff games (currently skipped,
  which would score every fantasy playoff matchup at zero), the takeaways/giveaways
  divergence between the per-game and aggregate scoring paths, and hits/blocks defaulting
  to 0 points.

- **Draft needs a significant overhaul.** User says a lot is wrong with the draft as it
  stands — scope not yet defined beyond that. Needs a follow-up conversation to pin down
  specifics (setup flow? live draft room UX? autopick/timer behavior? something else
  entirely) before this can be planned or built.

- **Dynasty season rollover.** Confirmed while scoping "view past seasons/playoff winners":
  DYNASTY leagues have no way to ever advance `currentSeason` today (`startNewSeason` is
  REDRAFT-only — see `src/lib/leagues/season.ts`), so the schedule/standings/playoff system
  only ever supports one season, permanently, for a dynasty league. User said "not yet" when
  asked whether to build this now. Needed before any past-season history page can show
  anything real. Design sketch when this comes back up: commissioner-triggered, rosters carry
  over completely untouched, only the schedule/standings/bracket archive and a new season
  starts — same shape as REDRAFT's rollover minus the roster wipe.
