// Seed/cleanup script for manually verifying the Scoreboard redesign
// (plans/scoreboard-batch.md, Task 1) in a real browser. NOT an assertion
// script — scripts/scoreboard-check.ts already covers the data-layer
// assertions and cleans up after itself immediately; this one seeds a
// 4-team league that stays around for a browser session, same two-script
// split as scripts/header-modal-test-league.ts.
//
// Usage:
//   npx tsx scripts/scoreboard-seed.ts            # seed
//   npx tsx scripts/scoreboard-seed.ts --cleanup   # delete by exact name

import { prisma } from "@/lib/db";
import { createLeague, createTeam, deleteLeague } from "@/lib/leagues/mutations";
import { generateSchedule } from "@/lib/matchups/mutations";

const LEAGUE_NAME = "Scoreboard Seed League (delete me)";
const SEASON = 2033;

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function cleanup() {
  const league = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (!league) {
    console.log("nothing to clean up — no league named", JSON.stringify(LEAGUE_NAME));
    return;
  }
  const fixturePlayers = await prisma.player.findMany({ where: { fullName: { contains: "Scoreboard Seed" } } });
  const fixtureIds = fixturePlayers.map((p) => p.id);
  const firstTeam = await prisma.team.findFirst({ where: { leagueId: league.id }, orderBy: { createdAt: "asc" } });
  await prisma.gameStatLine.deleteMany({ where: { playerId: { in: fixtureIds } } });
  await deleteLeague(league.id, league.commissionerUserId ?? firstTeam?.managerUserId ?? "scoreboard-seed-A");
  if (fixtureIds.length > 0) await prisma.player.deleteMany({ where: { id: { in: fixtureIds } } });
  console.log("deleted league:", LEAGUE_NAME, league.id, "and", fixtureIds.length, "fixture player(s)");
}

async function seed() {
  const existing = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (existing) {
    console.log("already seeded — league:", existing.id, "(run with --cleanup first to reseed)");
    return;
  }

  const { leagueId, teamId: teamA } = await createLeague({
    name: LEAGUE_NAME,
    season: SEASON,
    managerUserId: "scoreboard-seed-A",
    teamName: "Alpha Wolves",
    leagueType: "DYNASTY",
    rosterComposition: { positionMode: "SEPARATE", C: 2, LW: 1, RW: 1, F: 0, D: 2, G: 1, UTIL: 1, BENCH: 3 },
    farmSlots: 3,
    irSlots: 2,
  });
  const { teamId: teamB } = await createTeam({ leagueId, managerUserId: "scoreboard-seed-B", teamName: "Bravo Badgers" });
  const { teamId: teamC } = await createTeam({ leagueId, managerUserId: "scoreboard-seed-C", teamName: "Charlie Coyotes" });
  const { teamId: teamD } = await createTeam({ leagueId, managerUserId: "scoreboard-seed-D", teamName: "Delta Ducks" });

  // Period 1 fully in the past (final), period 2 straddles today (in
  // progress), period 3 entirely in the future (no lineup rows yet — that's
  // normal, see PROGRESS.md's Lineups section).
  const startDate = isoDaysFromNow(-10);
  await generateSchedule({ leagueId, season: SEASON, startDate, weekCount: 3, playoffTeams: 0, callerUserId: "scoreboard-seed-A" });
  const periods = await prisma.matchupPeriod.findMany({ where: { leagueId, season: SEASON }, orderBy: { periodNo: "asc" } });

  const teams = [
    { id: teamA, label: "Alpha" },
    { id: teamB, label: "Bravo" },
    { id: teamC, label: "Charlie" },
    { id: teamD, label: "Delta" },
  ];

  // Three skaters per team, real (varying) stat lines in the two periods
  // that have already started, so the scoreboard's Top Scorers column shows
  // real names/points instead of the pre-season 0.0 case (already covered
  // by scoreboard-check.ts and by the read-only Experimenting check).
  for (let t = 0; t < teams.length; t++) {
    const team = teams[t];
    for (let i = 0; i < 3; i++) {
      const slot = i === 0 ? "C" : i === 1 ? "D" : "UTIL";
      const player = await prisma.player.create({
        data: { fullName: `Scoreboard Seed ${team.label} Player${i + 1} (delete me)`, primaryPosition: i === 1 ? "D" : "C" },
      });
      for (const period of [periods[0], periods[1]]) {
        await prisma.lineupEntry.create({
          data: { teamId: team.id, playerId: player.id, gameDate: period.startDate, lineupSlot: slot },
        });
        // Varies by both player index and team index, so teams end up with
        // different totals (not a tie) — lets the browser check confirm the
        // trailing team's name actually goes muted once a period is final.
        const goals = 1 + i + t;
        const assists = 2 - i;
        await prisma.gameStatLine.create({
          data: {
            playerId: player.id,
            gameId: `sb-seed-${player.id}-${period.periodNo}`,
            gameDate: period.startDate,
            statsJson: { position: i === 1 ? "D" : "C", goals, assists, sog: 3 },
          },
        });
      }
    }
  }

  console.log("seeded league:", leagueId);
  console.log(
    "periods:",
    periods.map((p) => ({
      no: p.periodNo,
      start: p.startDate.toISOString().slice(0, 10),
      end: p.endDate.toISOString().slice(0, 10),
      final: p.endDate <= new Date(),
    })),
  );
  console.log(`Visit http://localhost:3000/leagues/${leagueId}/scoreboard`);
}

const args = process.argv.slice(2);
(args.includes("--cleanup") ? cleanup() : seed())
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
