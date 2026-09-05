// Playoff bracket advancement. Playoff MatchupPeriods are created empty at
// schedule-generation time (src/lib/matchups/mutations.ts's generateSchedule)
// — there's nothing to pair until the regular season actually finishes.
// This file fills them in round by round, cron-driven once daily, matching
// every other once-daily-resolution mechanic in this app (waiver claims,
// FAAB, trades).
//
// Standard fixed single-elimination bracket: seeds are set once from final
// regular-season standings and never re-seeded mid-bracket. Ties (impossible
// to leave unresolved in an elimination round, unlike the regular season)
// go to the better seed — which is always the home team here, by
// construction (see the pairing logic below).

import { prisma } from "@/lib/db";
import type { LeagueSettings } from "@/lib/leagues/mutations";
import { getStandings, getTeamScoreForPeriod } from "@/lib/matchups/standings";

/** Standard bracket seeding order — consecutive pairs are the real
 * single-elimination pairing (keeps seed 1 and 2 apart until the final).
 * standardSeedOrder(8) => [1,8,4,5,2,7,3,6], pairs (1,8) (4,5) (2,7) (3,6). */
export function standardSeedOrder(n: number): number[] {
  if (n === 1) return [1];
  const prev = standardSeedOrder(n / 2);
  const result: number[] = [];
  for (const s of prev) result.push(s, n + 1 - s);
  return result;
}

interface Seeded {
  teamId: string;
  seed: number;
}

function orderBySeed(a: Seeded, b: Seeded): [Seeded, Seeded] {
  return a.seed < b.seed ? [a, b] : [b, a];
}

/** Fills in as many playoff rounds as are currently ready, one league at a
 * time — looped so a stretch of cron downtime self-heals in one call rather
 * than requiring one call per missed round. */
export async function advancePlayoffsForLeague(leagueId: string, season: number): Promise<void> {
  const periods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season, isPlayoffs: true },
    orderBy: { periodNo: "asc" },
    include: { matchups: true },
  });
  if (periods.length === 0) return;

  const league = await prisma.league.findUniqueOrThrow({ where: { id: leagueId } });
  const settings = league.settingsJson as unknown as LeagueSettings;
  const bracketSize = 2 ** periods.length;

  for (let iteration = 0; iteration < periods.length; iteration++) {
    const fresh = await prisma.matchupPeriod.findMany({
      where: { leagueId, season, isPlayoffs: true },
      orderBy: { periodNo: "asc" },
      include: { matchups: true },
    });
    const index = fresh.findIndex((p) => p.matchups.length === 0);
    if (index === -1) return; // every round already has matchups — bracket complete

    if (index === 0) {
      const lastRegular = await prisma.matchupPeriod.findFirst({
        where: { leagueId, season, isPlayoffs: false },
        orderBy: { periodNo: "desc" },
      });
      if (!lastRegular || lastRegular.endDate > new Date()) return; // regular season isn't over yet

      const standings = await getStandings(leagueId, season, settings.scoringConfig);
      const seeded: Seeded[] = standings.slice(0, bracketSize).map((row, i) => ({ teamId: row.teamId, seed: i + 1 }));
      const order = standardSeedOrder(bracketSize);

      const rows = [];
      for (let i = 0; i < bracketSize / 2; i++) {
        const seedA = order[i * 2];
        const seedB = order[i * 2 + 1];
        const a = seeded[seedA - 1];
        const b = seeded[seedB - 1];
        const [better, worse] = orderBySeed(a, b);
        rows.push({
          matchupPeriodId: fresh[0].id,
          homeTeamId: better.teamId,
          homeSeed: better.seed,
          awayTeamId: worse.teamId,
          awaySeed: worse.seed,
          bracketSlot: i,
        });
      }
      await prisma.matchup.createMany({ data: rows });
      continue;
    }

    const previous = fresh[index - 1];
    if (previous.endDate > new Date()) return; // previous round isn't over yet

    const prevMatchups = [...previous.matchups].sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
    const winners: Seeded[] = [];
    for (const m of prevMatchups) {
      const [homeScore, awayScore] = await Promise.all([
        getTeamScoreForPeriod(m.homeTeamId, previous.startDate, previous.endDate, settings.scoringConfig),
        getTeamScoreForPeriod(m.awayTeamId, previous.startDate, previous.endDate, settings.scoringConfig),
      ]);
      // homeScore >= awayScore rather than > — a tie goes to home, which is
      // always the better seed by construction (see orderBySeed above).
      winners.push(
        homeScore >= awayScore
          ? { teamId: m.homeTeamId, seed: m.homeSeed! }
          : { teamId: m.awayTeamId, seed: m.awaySeed! },
      );
    }

    const rows = [];
    for (let i = 0; i < winners.length / 2; i++) {
      const [better, worse] = orderBySeed(winners[i * 2], winners[i * 2 + 1]);
      rows.push({
        matchupPeriodId: fresh[index].id,
        homeTeamId: better.teamId,
        homeSeed: better.seed,
        awayTeamId: worse.teamId,
        awaySeed: worse.seed,
        bracketSlot: i,
      });
    }
    await prisma.matchup.createMany({ data: rows });
  }
}

/** Cron entry point — every league with a playoff bracket for ITS OWN
 * current season gets one advancement pass. Each league can be on a
 * different season (redraft leagues advance independently), so this can't
 * filter by a single scalar season the way a single-season app could — it
 * has to join back to League and compare per row. */
export async function processDuePlayoffs(): Promise<void> {
  const rows = await prisma.matchupPeriod.findMany({
    where: { isPlayoffs: true },
    select: { leagueId: true, season: true, league: { select: { currentSeason: true } } },
    distinct: ["leagueId"],
    orderBy: { season: "desc" }, // so distinct keeps each league's MOST RECENT playoff season, not an arbitrary past one
  });
  const due = rows.filter((r) => r.season === r.league.currentSeason);
  for (const { leagueId, season } of due) {
    await advancePlayoffsForLeague(leagueId, season);
  }
}
