"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { isLeagueCommissioner } from "@/lib/leagues/mutations";
import {
  commissionerAddPlayer,
  commissionerDropPlayer,
  commissionerMovePlayer,
  addPlayerToRoster,
  dropPlayerFromRoster,
  sendToFarm,
  callUpToActive,
  placeOnIR,
  activateFromIR,
} from "@/lib/rosters/mutations";

export type PerformAs = "LM" | "TM";
export type RosterSlotType = "ACTIVE" | "FARM" | "IR";

// Every action here returns this instead of throwing, so the step-2 page can
// show the error inline with the "switch to League Manager" hint rather than
// crashing the Server Action boundary — a TM-mode refusal (free agency gate,
// waiver exposure, roster cap, etc.) is an expected, common outcome here, not
// an exceptional one.
export type RosterMoveResult = { ok: true; waiverExposed?: boolean } | { ok: false; error: string };

async function requireCommissionerTeam(leagueId: string, teamId: string, callerUserId: string) {
  if (!(await isLeagueCommissioner(leagueId, callerUserId))) {
    throw new Error("Only the league commissioner can use LM Roster Moves.");
  }
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || team.leagueId !== leagueId) throw new Error("Team not found in this league.");
  return team;
}

function errorResult(e: unknown): RosterMoveResult {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
}

export async function lmAddPlayerAction(
  leagueId: string,
  teamId: string,
  playerId: string,
  performAs: PerformAs,
  targetSlotType: RosterSlotType,
): Promise<RosterMoveResult> {
  const { userId } = await auth.protect();
  try {
    const team = await requireCommissionerTeam(leagueId, teamId, userId);
    if (performAs === "LM") {
      await commissionerAddPlayer({ leagueId, teamId, playerId, callerUserId: userId, targetSlotType });
    } else {
      // Team Manager mode is always ACTIVE-only — the step-2 form hides the
      // destination select in this mode, and addPlayerToRoster itself has no
      // slot concept (every normal Add lands on ACTIVE).
      await addPlayerToRoster({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
    }
    revalidatePath(`/leagues/${leagueId}/settings/roster-moves`);
    revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
    return { ok: true };
  } catch (e) {
    return errorResult(e);
  }
}

export async function lmDropPlayerAction(
  leagueId: string,
  teamId: string,
  playerId: string,
  performAs: PerformAs,
): Promise<RosterMoveResult> {
  const { userId } = await auth.protect();
  try {
    const team = await requireCommissionerTeam(leagueId, teamId, userId);
    if (performAs === "LM") {
      await commissionerDropPlayer({ leagueId, teamId, playerId, callerUserId: userId });
    } else {
      await dropPlayerFromRoster({ teamId, playerId, managerUserId: team.managerUserId });
    }
    revalidatePath(`/leagues/${leagueId}/settings/roster-moves`);
    revalidatePath(`/leagues/${leagueId}/teams/${teamId}`);
    return { ok: true };
  } catch (e) {
    return errorResult(e);
  }
}

export async function lmMovePlayerAction(
  leagueId: string,
  teamId: string,
  playerId: string,
  performAs: PerformAs,
  targetSlotType: RosterSlotType,
): Promise<RosterMoveResult> {
  const { userId } = await auth.protect();
  try {
    const team = await requireCommissionerTeam(leagueId, teamId, userId);
    if (performAs === "LM") {
      await commissionerMovePlayer({ leagueId, teamId, playerId, targetSlotType, callerUserId: userId });
      return { ok: true };
    }

    // Team Manager mode: no direct "move" primitive exists for a manager —
    // map onto whichever real mutation matches the actual current slot, the
    // same way that manager would have to click through on their own team
    // page. Each of these already re-checks ownership, cap, waivers, and the
    // ORPHAN_FROZEN gate on its own.
    const slot = await prisma.rosterSlot.findFirst({ where: { teamId, playerId, effectiveTo: null } });
    if (!slot) throw new Error("Player is not on this roster.");

    if (targetSlotType === "ACTIVE") {
      if (slot.slotType === "FARM") {
        await callUpToActive({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
      } else if (slot.slotType === "IR") {
        await activateFromIR({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
      } else {
        throw new Error("Player is already active.");
      }
      return { ok: true };
    }

    if (targetSlotType === "FARM") {
      if (slot.slotType === "ACTIVE") {
        const { waiverExposed } = await sendToFarm({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
        return { ok: true, waiverExposed };
      }
      if (slot.slotType === "IR") {
        // No single manager-facing mutation goes straight IR -> FARM —
        // activate to Active first, then send back down, surfacing whatever
        // waiver exposure that second leg produces.
        await activateFromIR({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
        const { waiverExposed } = await sendToFarm({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
        return { ok: true, waiverExposed };
      }
      throw new Error("Player is already on the farm.");
    }

    // targetSlotType === "IR" — placeOnIR only ever accepts an ACTIVE
    // player (DESIGN.md §2.6's worked example); a FARM player refused here
    // is expected, not a bug — the inline error + "switch to League
    // Manager" hint is exactly the right answer for that case.
    await placeOnIR({ leagueId, teamId, playerId, managerUserId: team.managerUserId });
    return { ok: true };
  } catch (e) {
    return errorResult(e);
  }
}
