"use client";

// Owns the Accept / Decline / Counter buttons on the trade review page
// (plans/trades-batch.md Task 3, issue #4/#5's accept-side UX). Decline and
// Counter are unchanged from before this task — plain <form action> submits
// straight to the existing Server Actions. Accept is the only one that
// changed: `overflowExcess` (computed server-side in review/page.tsx via
// computeTradeFit) tells it whether accepting would leave the *acceptor's*
// roster over cap. When it would, the click is intercepted client-side
// (preventDefault on the submit button, before the form ever posts) and a
// modal opens instead of submitting — the real accept still only ever
// happens through the same <form action={respondToTradeAction}> as before,
// just gated on the viewer actually having room. respondToTrade (Task 1)
// still re-checks this server-side regardless; this is UX, not the guard.
//
// Deliberately NOT called imperatively (no direct `await
// respondToTradeAction(...)` from a click handler) — respondToTradeAction
// ends in a Next.js redirect(), which next/navigation's own docs say can't
// be invoked from a client event handler, only during render or a real
// <form action> submission (same reasoning documented for proposeTradeAction
// in the Task 2 section of PROGRESS.md).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { respondToTradeAction, counterTradeAction } from "./actions";

export function AcceptTradeControls({
  leagueId,
  tradeId,
  myTeamId,
  overflowExcess,
}: {
  leagueId: string;
  tradeId: string;
  myTeamId: string;
  overflowExcess: number | null;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const hasOverflow = !!overflowExcess && overflowExcess > 0;

  return (
    <>
      <div className="mt-6 flex flex-wrap gap-2">
        <form action={respondToTradeAction.bind(null, leagueId, tradeId, true)}>
          <Button
            type="submit"
            variant="primary"
            onClick={(e) => {
              if (hasOverflow) {
                e.preventDefault();
                setModalOpen(true);
              }
            }}
          >
            Accept
          </Button>
        </form>
        <form action={respondToTradeAction.bind(null, leagueId, tradeId, false)}>
          <Button type="submit">Decline</Button>
        </form>
        <form action={counterTradeAction.bind(null, leagueId, tradeId)}>
          <Button type="submit">Counter</Button>
        </form>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Roster too full">
        <div className="space-y-4 p-4">
          <p className="text-sm">You must drop {overflowExcess} player(s) in order for this trade to go through.</p>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" onClick={() => setModalOpen(false)}>
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => router.push(`/leagues/${leagueId}/teams/${myTeamId}?dropMode=1&pendingTrade=${tradeId}`)}
            >
              Go to my team →
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
