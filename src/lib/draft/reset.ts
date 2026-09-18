// Reset Draft (LM Tools batch Task 9) — nuclear rollback for a draft that's
// already IN_PROGRESS or COMPLETE, allowed regardless of what's happened
// since. The draft goes back to SETUP with every pick's usedOnPlayerId
// cleared (round/overallPick/ownership, including traded picks, are kept).
//
// A NEW file, not draft/mutations.ts: trades/mutations.ts already imports
// assertNoDraftInProgress from draft/mutations.ts, so pulling cancelTrade
// (via wipeLeagueRosters) back into draft/mutations.ts would create a
// circular import. This file depends on both draft/mutations.ts (via the
// Draft/DraftPick tables) and leagues/season.ts and is depended on by
// neither, same shape as season.ts's own header comment.

import { prisma } from "@/lib/db";
import { isLeagueCommissioner } from "@/lib/leagues/mutations";
import { wipeLeagueRosters } from "@/lib/leagues/season";
import { todayUTC } from "@/lib/dates";

export interface ResetDraftInput {
  draftId: string;
  callerUserId: string;
}

export interface ResetDraftResult {
  cancelledTrades: number;
  voidedWaiverClaims: number;
  voidedFaBids: number;
  closedSlots: number;
  clearedPicks: number;
}

/** STARTUP empties every roster in the league (a startup draft is how the
 * league built its rosters in the first place); ROOKIE only removes the
 * players *this* draft selected, wherever they are now — a rookie draft
 * adds to existing rosters, so wiping everything would take back players a
 * manager acquired some other way entirely. */
export async function resetDraft(input: ResetDraftInput): Promise<ResetDraftResult> {
  const draft = await prisma.draft.findUniqueOrThrow({ where: { id: input.draftId } });
  if (!(await isLeagueCommissioner(draft.leagueId, input.callerUserId))) {
    throw new Error("Only the league commissioner can reset a draft.");
  }
  if (draft.status !== "IN_PROGRESS" && draft.status !== "COMPLETE") {
    throw new Error("Only a draft that's in progress or complete can be reset.");
  }

  const usedPicks = await prisma.draftPick.findMany({
    where: { draftId: draft.id, usedOnPlayerId: { not: null } },
    select: { usedOnPlayerId: true },
  });
  const usedOnPlayerIds = usedPicks.map((p) => p.usedOnPlayerId!);

  // Void pending claims/bids before closing the roster slots they reference
  // — otherwise a claim/bid could resolve against a slot this reset is
  // about to close out from under it on the next cron tick. Independent
  // tables from the trade-cancel/slot-close/lineup-delete steps below, so
  // the relative order between the two groups doesn't matter.
  const [{ count: voidedWaiverClaims }, { count: voidedFaBids }] = await Promise.all([
    prisma.waiverClaim.updateMany({
      where: { team: { leagueId: draft.leagueId }, result: "PENDING" },
      data: { result: "CLEARED" },
    }),
    prisma.faBid.deleteMany({ where: { team: { leagueId: draft.leagueId }, result: "PENDING" } }),
  ]);

  const { cancelledTrades, closedSlots } = await wipeLeagueRosters(draft.leagueId, input.callerUserId, {
    onlyPlayerIds: draft.type === "ROOKIE" ? usedOnPlayerIds : undefined,
    lineupEntriesFrom: todayUTC(),
  });

  const { count: clearedPicks } = await prisma.draftPick.updateMany({
    where: { draftId: draft.id, usedOnPlayerId: { not: null } },
    data: { usedOnPlayerId: null },
  });

  await prisma.draft.update({
    where: { id: draft.id },
    data: { status: "SETUP", currentPickDeadline: null, resolvingUntil: null },
  });

  await prisma.transactionLog.create({
    data: {
      leagueId: draft.leagueId,
      type: "COMMISSIONER_RESET",
      payload: {
        draftId: draft.id,
        draftType: draft.type,
        performedBy: input.callerUserId,
        cancelledTrades,
        voidedWaiverClaims,
        voidedFaBids,
        closedSlots,
        clearedPicks,
      },
    },
  });

  return { cancelledTrades, voidedWaiverClaims, voidedFaBids, closedSlots, clearedPicks };
}

export interface ResettableDraftPreview {
  draftId: string;
  season: number;
  type: "STARTUP" | "ROOKIE";
  status: "IN_PROGRESS" | "COMPLETE";
  teamCount: number;
  openSlotsToClose: number;
  picksToUnuse: number;
}

/** Read-only preview for the settings/reset-draft page — computed the same
 * way resetDraft itself would scope its own writes, so the "what will
 * happen" copy can never drift from the real mutation. */
export async function getResettableDraftsPreview(leagueId: string): Promise<ResettableDraftPreview[]> {
  const drafts = await prisma.draft.findMany({
    where: { leagueId, status: { in: ["IN_PROGRESS", "COMPLETE"] } },
    orderBy: { createdAt: "desc" },
  });
  if (drafts.length === 0) return [];

  const teamCount = await prisma.team.count({ where: { leagueId } });

  const previews: ResettableDraftPreview[] = [];
  for (const draft of drafts) {
    const usedPicks = await prisma.draftPick.findMany({
      where: { draftId: draft.id, usedOnPlayerId: { not: null } },
      select: { usedOnPlayerId: true },
    });
    const openSlotsToClose = await prisma.rosterSlot.count({
      where: {
        team: { leagueId },
        effectiveTo: null,
        ...(draft.type === "ROOKIE" ? { playerId: { in: usedPicks.map((p) => p.usedOnPlayerId!) } } : {}),
      },
    });
    previews.push({
      draftId: draft.id,
      season: draft.season,
      type: draft.type,
      status: draft.status as "IN_PROGRESS" | "COMPLETE",
      teamCount,
      openSlotsToClose,
      picksToUnuse: usedPicks.length,
    });
  }
  return previews;
}
