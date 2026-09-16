"use client";

// ESPN-style trade builder (plans/trades-batch.md Task 2). Layout, top to
// bottom: counterparty picker, their full roster (checklist), a scroll-down
// button, your full roster (checklist), a sticky bottom bar summarizing the
// current selection with Continue/Cancel, and a Confirm Trade modal that
// actually sends the proposal. Replaces the old two-step
// step: "select" | "review" flow and AssetChecklist (both deleted) — the
// review step now lives in this same component as the confirm modal instead
// of a full-page navigation.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { TradeRosterTable } from "./TradeRosterTable";
import { proposeTradeAction } from "./actions";
import type { TradeableAssets, TradeAssetSelection } from "@/lib/trades/mutations";
import type { PlayerStatsRow } from "@/lib/players/rankings";

const EMPTY_SELECTION: TradeAssetSelection = { playerIds: [], pickIds: [], faabAmount: 0 };

function totalItems(sel: TradeAssetSelection): number {
  return sel.playerIds.length + sel.pickIds.length + (sel.faabAmount > 0 ? 1 : 0);
}

function pickChipLabel(round: number, season: number): string {
  return `R${round} ${season}`;
}

function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

interface AssetPlayerInfo {
  fullName: string;
  headshotUrl: string | null;
  currentNhlOrg: string | null;
  primaryPosition: string | null;
}

export function TradeBuilder({
  leagueId,
  myTeamId,
  myTeamName,
  myAssets,
  otherTeams,
  counterpartyId,
  counterpartyName,
  counterpartyAssets,
  statsById,
  initialGive,
  initialReceive,
}: {
  leagueId: string;
  myTeamId: string;
  myTeamName: string;
  myAssets: TradeableAssets;
  otherTeams: { teamId: string; teamName: string }[];
  counterpartyId: string;
  counterpartyName: string;
  counterpartyAssets: TradeableAssets;
  statsById: Record<string, PlayerStatsRow>;
  initialGive: TradeAssetSelection;
  initialReceive: TradeAssetSelection;
}) {
  const router = useRouter();
  const yourRosterRef = useRef<HTMLDivElement>(null);

  const [give, setGive] = useState<TradeAssetSelection>(initialGive);
  const [receive, setReceive] = useState<TradeAssetSelection>(initialReceive);
  const [modalOpen, setModalOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const playerLookup = useMemo(() => {
    const map = new Map<string, AssetPlayerInfo>();
    for (const p of myAssets.players) map.set(p.id, p);
    for (const p of counterpartyAssets.players) map.set(p.id, p);
    return map;
  }, [myAssets, counterpartyAssets]);

  const pickLookup = useMemo(() => {
    const map = new Map<string, { season: number; round: number }>();
    for (const pk of myAssets.picks) map.set(pk.id, pk);
    for (const pk of counterpartyAssets.picks) map.set(pk.id, pk);
    return map;
  }, [myAssets, counterpartyAssets]);

  function toggle(sel: TradeAssetSelection, setSel: (s: TradeAssetSelection) => void, key: "playerIds" | "pickIds", id: string) {
    const list = sel[key];
    setSel({ ...sel, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  }

  function handleCancelTrade() {
    setGive(EMPTY_SELECTION);
    setReceive(EMPTY_SELECTION);
  }

  const canContinue = totalItems(give) + totalItems(receive) > 0;

  async function handleSend() {
    setSending(true);
    setSendError(null);
    const result = await proposeTradeAction(leagueId, myTeamId, counterpartyId, give, receive);
    if (result.ok) {
      router.push(result.redirectTo);
      return; // navigating away — leave the button disabled through the transition
    }
    setSendError(result.error);
    setSending(false);
  }

  function renderChips(sel: TradeAssetSelection): ReactNode[] {
    const nodes: ReactNode[] = [];
    for (const id of sel.playerIds) {
      const p = playerLookup.get(id);
      if (!p) continue;
      nodes.push(
        <span key={`p:${id}`} className="inline-flex items-center gap-1.5 rounded-full bg-surface-tint px-2 py-0.5 text-xs">
          <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={24} />
          {lastName(p.fullName)}
        </span>,
      );
    }
    for (const id of sel.pickIds) {
      const pk = pickLookup.get(id);
      if (!pk) continue;
      nodes.push(
        <span key={`pk:${id}`} className="inline-flex items-center rounded-full bg-surface-tint px-2 py-0.5 text-xs">
          {pickChipLabel(pk.round, pk.season)}
        </span>,
      );
    }
    if (sel.faabAmount > 0) {
      nodes.push(
        <span key="faab" className="inline-flex items-center rounded-full bg-surface-tint px-2 py-0.5 text-xs">
          ${sel.faabAmount} FAAB
        </span>,
      );
    }
    return nodes;
  }

  function renderConfirmSide(sel: TradeAssetSelection, arrow: "in" | "out") {
    const items: ReactNode[] = [];
    for (const id of sel.playerIds) {
      const p = playerLookup.get(id);
      if (!p) continue;
      items.push(
        <div key={`p:${id}`} className="flex items-center gap-2 py-1 text-sm">
          {arrow === "out" && <span className="text-blue">←</span>}
          <PlayerHeadshot url={p.headshotUrl} alt={p.fullName} size={24} />
          <span>{p.fullName}</span>
          <span className="text-xs text-muted">
            {p.currentNhlOrg ?? "—"} · {p.primaryPosition ?? "—"}
          </span>
          {arrow === "in" && <span className="ml-auto text-blue">→</span>}
        </div>,
      );
    }
    for (const id of sel.pickIds) {
      const pk = pickLookup.get(id);
      if (!pk) continue;
      items.push(
        <div key={`pk:${id}`} className="flex items-center gap-2 py-1 text-sm">
          {arrow === "out" && <span className="text-blue">←</span>}
          <span>
            {pk.season} Round {pk.round}
          </span>
          {arrow === "in" && <span className="ml-auto text-blue">→</span>}
        </div>,
      );
    }
    if (sel.faabAmount > 0) {
      items.push(
        <div key="faab" className="flex items-center gap-2 py-1 text-sm">
          {arrow === "out" && <span className="text-blue">←</span>}
          <span>${sel.faabAmount} FAAB</span>
          {arrow === "in" && <span className="ml-auto text-blue">→</span>}
        </div>,
      );
    }
    return items.length > 0 ? items : <p className="text-xs text-muted">Nothing.</p>;
  }

  return (
    <div>
      <Card className="mt-4">
        <label className="block text-sm">
          <span className="text-xs text-muted">Trade with</span>
          <select
            value={counterpartyId}
            onChange={(e) => router.push(`/leagues/${leagueId}/trades/new?with=${e.target.value}`)}
            className="mt-1 block w-full max-w-sm rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          >
            {otherTeams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.teamName}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <div className="mt-6">
        <p className="mb-2 text-sm font-semibold">{counterpartyName}&apos;s roster</p>
        <Card>
          <TradeRosterTable
            assets={counterpartyAssets}
            statsById={statsById}
            selected={receive}
            onTogglePlayer={(id) => toggle(receive, setReceive, "playerIds", id)}
            onTogglePick={(id) => toggle(receive, setReceive, "pickIds", id)}
            onFaabChange={(amount) => setReceive({ ...receive, faabAmount: amount })}
          />
        </Card>
        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => yourRosterRef.current?.scrollIntoView({ behavior: "smooth" })}
          >
            ↓ Select who to offer below
          </Button>
        </div>
      </div>

      <div ref={yourRosterRef} className="mt-8">
        <p className="mb-2 text-sm font-semibold">Your roster ({myTeamName})</p>
        <Card>
          <TradeRosterTable
            assets={myAssets}
            statsById={statsById}
            selected={give}
            onTogglePlayer={(id) => toggle(give, setGive, "playerIds", id)}
            onTogglePick={(id) => toggle(give, setGive, "pickIds", id)}
            onFaabChange={(amount) => setGive({ ...give, faabAmount: amount })}
          />
        </Card>
      </div>

      <div className="sticky bottom-0 z-10 -mx-6 mt-6 border-t border-border bg-surface px-6 py-3 shadow-lg">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[220px] flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Receiving — {counterpartyName}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {totalItems(receive) === 0 ? (
                <span className="text-xs text-muted">Nothing selected.</span>
              ) : (
                renderChips(receive)
              )}
            </div>
          </div>
          <div className="min-w-[220px] flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Offering — {myTeamName}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {totalItems(give) === 0 ? <span className="text-xs text-muted">Nothing selected.</span> : renderChips(give)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="secondary" onClick={handleCancelTrade}>
              Cancel Trade
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!canContinue}
              onClick={() => {
                setSendError(null);
                setModalOpen(true);
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>

      <Modal open={modalOpen} onClose={() => !sending && setModalOpen(false)} title="Confirm Trade">
        <div className="space-y-4 p-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Receiving from {counterpartyName}</p>
            <div className="divide-y divide-border">{renderConfirmSide(receive, "in")}</div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Offering to {counterpartyName}</p>
            <div className="divide-y divide-border">{renderConfirmSide(give, "out")}</div>
          </div>
          {sendError && <p className="text-sm text-danger">{sendError}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" onClick={() => setModalOpen(false)} disabled={sending}>
              Back
            </Button>
            <Button type="button" variant="primary" onClick={handleSend} disabled={sending}>
              {sending ? "Sending…" : "Send Trade Proposal"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
