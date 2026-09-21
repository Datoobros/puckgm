// Commissioner scoring corrections (LM Tools Task 10, plans/lm-tools-batch.md
// Task 10). A ScoreAdjustment is a real, stored value — the one exception to
// this app's "always compute the score live" rule — summed into
// getTeamScoreForPeriod (src/lib/matchups/standings.ts) so every consumer
// (standings, scoreboard, matchup detail, team schedule, playoff advancement)
// agrees on the adjusted total.

import { prisma } from "@/lib/db";
import { isLeagueCommissioner } from "@/lib/leagues/mutations";

export interface ScoreAdjustmentRow {
  id: string;
  leagueId: string;
  matchupPeriodId: string;
  teamId: string;
  points: number;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function addScoreAdjustment(input: {
  leagueId: string;
  matchupPeriodId: string;
  teamId: string;
  points: number;
  reason?: string | null;
  callerUserId: string;
}): Promise<ScoreAdjustmentRow> {
  if (!(await isLeagueCommissioner(input.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can adjust scoring.");
  }
  if (!Number.isFinite(input.points) || input.points === 0) {
    throw new Error("Adjustment points must be a nonzero number.");
  }

  const period = await prisma.matchupPeriod.findUnique({ where: { id: input.matchupPeriodId } });
  if (!period || period.leagueId !== input.leagueId) throw new Error("Matchup period not found in this league.");

  // The team must actually be playing this period — an adjustment to a team
  // with no matchup that week has nothing to attach to (no result to flip).
  const inMatchup = await prisma.matchup.findFirst({
    where: { matchupPeriodId: input.matchupPeriodId, OR: [{ homeTeamId: input.teamId }, { awayTeamId: input.teamId }] },
    select: { id: true },
  });
  if (!inMatchup) throw new Error("That team has no matchup in this period.");

  return prisma.scoreAdjustment.create({
    data: {
      leagueId: input.leagueId,
      matchupPeriodId: input.matchupPeriodId,
      teamId: input.teamId,
      points: input.points,
      reason: input.reason?.trim() || null,
      createdBy: input.callerUserId,
    },
  });
}

export async function removeScoreAdjustment(input: { id: string; callerUserId: string }): Promise<void> {
  const adjustment = await prisma.scoreAdjustment.findUnique({ where: { id: input.id } });
  if (!adjustment) throw new Error("Adjustment not found.");
  if (!(await isLeagueCommissioner(adjustment.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can remove a scoring adjustment.");
  }
  await prisma.scoreAdjustment.delete({ where: { id: input.id } });
}

export async function listScoreAdjustments(matchupPeriodId: string): Promise<ScoreAdjustmentRow[]> {
  return prisma.scoreAdjustment.findMany({ where: { matchupPeriodId }, orderBy: { createdAt: "asc" } });
}
