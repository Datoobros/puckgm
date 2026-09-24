"use client";

import { useState } from "react";
import { Card } from "@/components/Card";
import { Button, LinkButton } from "@/components/Button";
import { AddPlayerCell } from "@/app/leagues/[id]/players/AddPlayerCell";
import { submitFaBidAction, cancelFaBidAction } from "@/app/leagues/[id]/players/actions";
import { dropPlayerAction } from "@/app/leagues/[id]/teams/[teamId]/actions";
import { submitWaiverClaimAction, cancelWaiverClaimAction } from "@/app/leagues/[id]/waivers/actions";
import type { PlayerLeagueStatus } from "@/lib/players/profile";

/** The player-profile modal's action card — one full-width button (ESPN's
 * DROP), branch chosen by the viewer's team and the player's league status.
 * Exactly one of the eight branches below renders, in this priority order
 * (plans/player-modal-batch.md's "Action card" decision — don't reorder). */
export function PlayerProfileActions({
  leagueId,
  playerId,
  playerName,
  status,
  onChanged,
}: {
  leagueId: string;
  playerId: string;
  playerName: string;
  status: PlayerLeagueStatus;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDrop, setConfirmingDrop] = useState(false);

  async function run(action: () => Promise<void>, failureMessage: string) {
    setPending(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : failureMessage);
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDrop() {
    setPending(true);
    setError(null);
    try {
      await dropPlayerAction(leagueId, status.viewerTeamId!, playerId);
      setConfirmingDrop(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't drop that player.");
    } finally {
      setPending(false);
    }
  }

  // 1. No team in this league.
  if (!status.viewerTeamId) return null;

  // 2. Viewer's team is orphaned/frozen — mutations already refuse; avoid a
  // dead button.
  if (status.viewerTeamFrozen) {
    return (
      <Card>
        <p className="text-sm text-muted">Your team is orphaned — its roster is frozen.</p>
      </Card>
    );
  }

  // 3. On the viewer's own team.
  if (status.onMyTeam) {
    if (confirmingDrop) {
      return (
        <Card>
          <div className="flex flex-col gap-2">
            <span className="text-sm">Drop {playerName}?</span>
            <div className="flex gap-2">
              <Button type="button" variant="danger" className="flex-1" disabled={pending} onClick={handleConfirmDrop}>
                Confirm drop
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirmingDrop(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </Card>
      );
    }
    return (
      <Card>
        <Button type="button" variant="danger" className="w-full" onClick={() => setConfirmingDrop(true)}>
          DROP
        </Button>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </Card>
    );
  }

  // 4. On waivers from another team.
  if (status.waivers) {
    const claimId = status.waivers.myPendingClaimId;
    return (
      <Card>
        {claimId ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted">Claim pending</span>
            <Button
              type="button"
              variant="danger"
              className="w-full"
              disabled={pending}
              onClick={() => run(() => cancelWaiverClaimAction(leagueId, claimId), "Couldn't cancel that claim.")}
            >
              CANCEL CLAIM
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="primary"
            className="w-full"
            disabled={pending}
            onClick={() => run(() => submitWaiverClaimAction(leagueId, playerId), "Couldn't submit a waiver claim.")}
          >
            CLAIM
          </Button>
        )}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </Card>
    );
  }

  // 5. On another team (not on waivers).
  if (status.ownedBy) {
    return (
      <Card>
        <LinkButton variant="primary" className="w-full" href={`/leagues/${leagueId}/trades/new?with=${status.ownedBy.teamId}`}>
          PROPOSE TRADE
        </LinkButton>
      </Card>
    );
  }

  // 6. Free agent, free agency closed.
  if (!status.freeAgencyOpen) {
    return (
      <Card>
        <p className="text-sm text-muted">Free agency is closed until the draft is complete.</p>
      </Card>
    );
  }

  // 7. Free agent, FAAB league.
  if (status.faab) {
    const { minBid, maxBid, myPendingBid } = status.faab;
    if (myPendingBid) {
      return (
        <Card>
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted">
              Bid pending: ${myPendingBid.amount} → {myPendingBid.targetSlot === "FARM" ? "Farm" : "Active"}
            </span>
            <Button
              type="button"
              variant="danger"
              className="w-full"
              disabled={pending}
              onClick={() => run(() => cancelFaBidAction(leagueId, myPendingBid.id), "Couldn't cancel that bid.")}
            >
              CANCEL BID
            </Button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </Card>
      );
    }
    return (
      <Card>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            run(() => submitFaBidAction(leagueId, playerId, formData), "Couldn't submit that bid.");
          }}
        >
          <div className="flex items-center gap-2">
            <input
              name="amount"
              type="number"
              min={minBid}
              max={maxBid ?? undefined}
              defaultValue={minBid}
              required
              className="w-24 rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            />
            <select
              name="targetSlot"
              defaultValue="ACTIVE"
              className="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            >
              <option value="ACTIVE">Active</option>
              <option value="FARM">Farm</option>
            </select>
          </div>
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            BID
          </Button>
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      </Card>
    );
  }

  // 8. Free agent, non-FAAB.
  return (
    <Card>
      <AddPlayerCell
        size="pill"
        leagueId={leagueId}
        teamId={status.viewerTeamId}
        playerId={playerId}
        activeCount={status.activeCount}
        activeCap={status.activeCap}
        activeRosterPlayers={status.activeRosterPlayers}
        onDone={onChanged}
      />
    </Card>
  );
}
