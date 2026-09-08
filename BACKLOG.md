# Backlog — requested changes not yet built

Running list of things the user wants changed or added, captured as-is until there's enough
detail to plan and build. When an item ships, move it off this list and document it in
`PROGRESS.md` the way every other feature is — this file is just the queue, not the record.

## Open

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

- **Player profile modal.** Clicking a player anywhere (Players page, roster page) should open
  a modal with season stats, avg points, position rank, and a transaction-history list at the
  bottom (ESPN-style). User wants to design the exact contents/layout together rather than
  have it built to a guess — revisit and get details before building.
