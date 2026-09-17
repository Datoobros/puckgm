// Needs-based autopick ranking (draft-fix-batch Task 2) — replaces "just take
// the highest career-points player," which is what let autopick draft 24
// goalies in a row against Experimenting: goalies score far more than
// skaters under most scoring configs, and nothing accounted for what a
// team's roster actually still needed. See plans/draft-fix-batch.md.
//
// Two halves: pure math (position groups, per-team targets, value-over-
// replacement) a script can test against hand-computed numbers without
// touching the DB, and getLeagueNeeds, the one data loader that reads
// current roster composition across the league to feed those pure
// functions.

import { prisma } from "@/lib/db";
import type { LeagueSettings, RosterComposition } from "@/lib/leagues/mutations";
import { eligibleSlotsForPosition, capFor } from "@/lib/lineups/mutations";
import { getPlayerStatsAggregate } from "@/lib/players/rankings";
import { STAT_RANGES } from "@/lib/players/seasons";
import type { ScoringConfig } from "@/lib/scoring/engine";

export type PositionMode = RosterComposition["positionMode"];

/** The starting-position groups a draft cares about, per the league's
 * positionMode — mirrors the starting slots in src/lib/lineups/mutations.ts
 * minus UTIL/BE, which aren't a "position" a player is drafted to fill. */
export function positionGroupsFor(positionMode: PositionMode): string[] {
  return positionMode === "COMBINED" ? ["F", "D", "G"] : ["C", "L", "R", "D", "G"];
}

/** Which single group a player's real position counts toward — the one
 * non-UTIL starting slot eligibleSlotsForPosition returns for him. A player
 * matches exactly one such slot under either positionMode (COMBINED folds
 * C/L/R into "F"; SEPARATE keeps them distinct), so [0] is always the right
 * answer, never a real ambiguity to resolve. */
export function groupForPosition(position: string | null, positionMode: PositionMode): string | null {
  const slots = eligibleSlotsForPosition(position, positionMode).filter((s) => s !== "UTIL");
  return slots[0] ?? null;
}

/** Splits `pool` proportionally across `weights`, rounding half up and
 * handing any leftover (positive or negative, from rounding every share)
 * to the largest-weight group — guarantees the shares sum to exactly `pool`. */
function splitProportional(pool: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || pool === 0) return weights.map(() => 0);
  const rounded = weights.map((w) => Math.round((pool * w) / total));
  const diff = pool - rounded.reduce((s, x) => s + x, 0);
  if (diff !== 0) {
    let largestIdx = 0;
    for (let i = 1; i < weights.length; i++) {
      if (weights[i] > weights[largestIdx]) largestIdx = i;
    }
    rounded[largestIdx] += diff;
  }
  return rounded;
}

/** Per-team target roster count for each position group: the group's
 * starting-slot count (capFor) plus a share of the bench (UTIL + BENCH,
 * split across skater groups proportionally to their starter counts).
 * Goalies get a bench share of exactly 1 rather than a proportional cut —
 * this is also the league's hard cap on goalies (see goalieHardCap), since
 * a proportional share would inflate it right back to the original bug
 * (goalies outscore skaters, so "need" would never stop wanting more). */
export function computeGroupTargets(comp: RosterComposition): Record<string, number> {
  const positionMode = comp.positionMode;
  const groups = positionGroupsFor(positionMode);
  const starters: Record<string, number> = {};
  for (const g of groups) starters[g] = capFor(g, comp) ?? 0;

  const skaterGroups = groups.filter((g) => g !== "G");
  const benchPool = comp.UTIL + comp.BENCH;
  const shares = splitProportional(
    benchPool,
    skaterGroups.map((g) => starters[g]),
  );

  const targets: Record<string, number> = {};
  skaterGroups.forEach((g, i) => {
    targets[g] = starters[g] + shares[i];
  });
  targets.G = starters.G + 1;
  return targets;
}

/** A team never autopicks more goalies than this, ever — including farm
 * rounds, even once every group's "need" has hit zero. Numerically the same
 * as computeGroupTargets(...).G by construction; kept as its own named
 * export because it's enforced as an unconditional backstop in
 * chooseAutopick's "best available" branch, not just a byproduct of need
 * reaching zero. */
export function goalieHardCap(comp: RosterComposition): number {
  return (capFor("G", comp) ?? 0) + 1;
}

export interface RankedPoolPlayer {
  id: string;
  fullName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
  group: string | null;
  /** Only meaningful relative to other players from the same pool build —
   * not a real point total once the zero-season-game offset below is
   * applied to a STARTUP pool. */
  value: number;
}

/** The most recent season bucket (src/lib/players/seasons.ts's STAT_RANGES)
 * that actually has ingested games — "today" can fall inside a season
 * bucket with zero games (see PROGRESS.md's lineups section), so this finds
 * the real most-recent data rather than trusting the calendar. Null only if
 * the league has never ingested a single game. */
export async function getMostRecentIngestedSeasonRange(): Promise<{ start: Date; end: Date } | null> {
  const result = await prisma.gameStatLine.aggregate({ _max: { gameDate: true } });
  const maxDate = result._max.gameDate;
  if (!maxDate) return null;
  const season = STAT_RANGES.find((r) => r.kind === "season" && maxDate >= r.start && maxDate <= r.end);
  return season && season.kind === "season" ? { start: season.start, end: season.end } : null;
}

// Pushes every zero-season-game player's value below every real in-season
// value, matching the intended sort (season-games players always rank above
// season-less ones) while still leaving career points to break ties among
// the season-less group itself.
const ZERO_SEASON_VALUE_OFFSET = 1_000_000;

interface StartupCandidate {
  id: string;
  fullName: string;
  primaryPosition: string | null;
  currentNhlOrg: string | null;
  group: string | null;
  hasSeasonGames: boolean;
  seasonPoints: number;
  careerPoints: number;
}

function compareStartupCandidates(a: StartupCandidate, b: StartupCandidate): number {
  if (a.hasSeasonGames !== b.hasSeasonGames) return a.hasSeasonGames ? -1 : 1;
  if (a.seasonPoints !== b.seasonPoints) return b.seasonPoints - a.seasonPoints;
  if (a.careerPoints !== b.careerPoints) return b.careerPoints - a.careerPoints;
  return a.fullName.localeCompare(b.fullName);
}

/** STARTUP draft value: fantasy points in the most recent fully-ingested
 * season, tie-broken by career points then name. A player with zero games
 * that season ranks by career points instead, but always below every player
 * who actually played this season — a long-retired or not-yet-debuted
 * player shouldn't outrank a real, currently active one just because his
 * career total happens to be higher. */
export async function buildStartupValuePool(
  positionMode: PositionMode,
  scoringConfig: ScoringConfig,
): Promise<RankedPoolPlayer[]> {
  const seasonRange = await getMostRecentIngestedSeasonRange();
  const [careerRows, seasonRows] = await Promise.all([
    getPlayerStatsAggregate({ scoringConfig }),
    seasonRange ? getPlayerStatsAggregate({ scoringConfig, dateRange: seasonRange }) : Promise.resolve([]),
  ]);
  const seasonByPlayer = new Map(seasonRows.map((r) => [r.id, r]));

  const candidates: StartupCandidate[] = careerRows.map((career) => {
    const season = seasonByPlayer.get(career.id);
    const hasSeasonGames = !!season && season.gamesIngested > 0;
    return {
      id: career.id,
      fullName: career.fullName,
      primaryPosition: career.primaryPosition,
      currentNhlOrg: career.currentNhlOrg,
      group: groupForPosition(career.primaryPosition, positionMode),
      hasSeasonGames,
      seasonPoints: hasSeasonGames ? season!.points : 0,
      careerPoints: career.points,
    };
  });
  candidates.sort(compareStartupCandidates);

  return candidates.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    primaryPosition: c.primaryPosition,
    currentNhlOrg: c.currentNhlOrg,
    group: c.group,
    value: c.hasSeasonGames ? c.seasonPoints : c.careerPoints - ZERO_SEASON_VALUE_OFFSET,
  }));
}

/** ROOKIE draft value: real NHL draft position (prospects have no stats
 * yet) — lower overallPick is better, so value counts down from the pool
 * size. Already the board order this app shipped before Task 2; unchanged
 * here except for gaining a `group` so the needs step below can use it. */
export async function buildRookieValuePool(season: number, positionMode: PositionMode): Promise<RankedPoolPlayer[]> {
  const prospects = await prisma.player.findMany({
    where: { draftYear: season },
    orderBy: { draftOverallPick: "asc" },
  });
  return prospects.map((p, index) => ({
    id: p.id,
    fullName: p.fullName,
    primaryPosition: p.primaryPosition,
    currentNhlOrg: p.currentNhlOrg,
    group: groupForPosition(p.primaryPosition, positionMode),
    value: prospects.length - index,
  }));
}

export interface LeagueNeeds {
  targets: Record<string, number>;
  haveByTeam: Map<string, Record<string, number>>;
  needByTeam: Map<string, Record<string, number>>;
  /** Σ over teams of max(0, target[group] − have[group]) — how many players
   * of this group the league as a whole is still short, used as the
   * "replacement level" index into a group's sorted available list. */
  remainingLeagueNeed: Record<string, number>;
}

/** The one DB-backed loader in this file — everything else here is pure.
 * Reads every team's currently-open roster slots (any tier: a player on IR
 * still occupies a spot the draft can't also fill, same reasoning as
 * getMaxDraftRounds) to compute each team's per-group "have," then derives
 * need and the league-wide remaining need from computeGroupTargets. */
export async function getLeagueNeeds(leagueId: string, settings: LeagueSettings): Promise<LeagueNeeds> {
  const comp = settings.rosterComposition;
  const positionMode = comp.positionMode;
  const groups = positionGroupsFor(positionMode);
  const targets = computeGroupTargets(comp);

  const teams = await prisma.team.findMany({ where: { leagueId }, select: { id: true } });
  const slots = await prisma.rosterSlot.findMany({
    where: { effectiveTo: null, team: { leagueId } },
    select: { teamId: true, player: { select: { primaryPosition: true } } },
  });

  const haveByTeam = new Map<string, Record<string, number>>();
  for (const t of teams) haveByTeam.set(t.id, Object.fromEntries(groups.map((g) => [g, 0])));
  for (const slot of slots) {
    const group = groupForPosition(slot.player.primaryPosition, positionMode);
    if (!group) continue;
    const have = haveByTeam.get(slot.teamId);
    if (have) have[group] = (have[group] ?? 0) + 1;
  }

  const needByTeam = new Map<string, Record<string, number>>();
  const remainingLeagueNeed: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]));
  for (const t of teams) {
    const have = haveByTeam.get(t.id)!;
    const need: Record<string, number> = {};
    for (const g of groups) {
      need[g] = Math.max(0, targets[g] - (have[g] ?? 0));
      remainingLeagueNeed[g] += need[g];
    }
    needByTeam.set(t.id, need);
  }

  return { targets, haveByTeam, needByTeam, remainingLeagueNeed };
}

export interface AutopickDecision {
  player: RankedPoolPlayer;
  reason: "NEED" | "BEST_AVAILABLE";
}

/** The actual pick: among groups this team still needs (per computeGroupTargets),
 * take the one with the highest value-over-replacement and grab its best
 * available player. Once no group has need left (farm rounds, or a small
 * roster that's already full up), fall back to the single best available
 * player league-wide — except a goalie once the team's already at
 * goalieHardCap, which is skipped even here. Null only when the pool itself
 * is empty. */
export function chooseAutopick(input: {
  pool: RankedPoolPlayer[];
  positionMode: PositionMode;
  need: Record<string, number>;
  remainingLeagueNeed: Record<string, number>;
  hardCapG: number;
  haveG: number;
}): AutopickDecision | null {
  const { pool, positionMode, need, remainingLeagueNeed, hardCapG, haveG } = input;
  if (pool.length === 0) return null;

  const groups = positionGroupsFor(positionMode);
  const byGroup = new Map<string, RankedPoolPlayer[]>();
  for (const g of groups) {
    byGroup.set(
      g,
      pool.filter((p) => p.group === g).sort((a, b) => b.value - a.value),
    );
  }

  const groupsWithNeed = groups.filter((g) => (need[g] ?? 0) > 0 && (byGroup.get(g)?.length ?? 0) > 0);
  if (groupsWithNeed.length > 0) {
    let bestGroup = groupsWithNeed[0];
    let bestVOR = -Infinity;
    for (const g of groupsWithNeed) {
      const list = byGroup.get(g)!;
      const bestVal = list[0].value;
      const replIdx = Math.min(Math.max(remainingLeagueNeed[g] ?? 0, 0), list.length - 1);
      const replVal = list[replIdx].value;
      const vor = bestVal - replVal;
      if (vor > bestVOR) {
        bestVOR = vor;
        bestGroup = g;
      }
    }
    return { player: byGroup.get(bestGroup)![0], reason: "NEED" };
  }

  const sortedByValue = [...pool].sort((a, b) => b.value - a.value);
  for (const p of sortedByValue) {
    if (p.group === "G" && haveG >= hardCapG) continue;
    return { player: p, reason: "BEST_AVAILABLE" };
  }
  // Every remaining player is a group at its hard cap (only reachable if
  // the pool is down to nothing but goalies past the cap) — draft one
  // anyway rather than throw; a pick must land on someone.
  return { player: sortedByValue[0], reason: "BEST_AVAILABLE" };
}
