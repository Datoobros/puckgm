"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/Button";

/** Reusable modal dialog — first user is the team page's Notifications
 * button (src/app/leagues/[id]/teams/[teamId]/NotificationsButton.tsx); the
 * player-profile modal (plans/player-modal-batch.md Task 3) reuses this same
 * component via `bare`. Built on the native <dialog> element specifically
 * so Esc-to-close and focus containment come for free from the browser
 * instead of being hand-rolled. Light-only theme (no dark: variants), matching
 * the rest of the redesign covered in PROGRESS.md's "UI re-theme" section. */
export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
  bare = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** "xl" (max-w-3xl) for the player-profile modal's tall card column; "md"
   * (max-w-lg, the original width) for every other current user. */
  size?: "md" | "xl";
  /** No title bar, transparent dialog background, children own the cards
   * and the scroll — the player-profile modal's own sticky ✕ and stacked
   * Cards render directly against the dark backdrop. Default false leaves
   * every existing user (NotificationsButton, AdjustScoringModal,
   * AcceptTradeControls, TradeBuilder) untouched. */
  bare?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // `overflow-y: auto` on the dialog forces `overflow-x` to compute as
  // `auto` too (CSS Overflow spec — a non-`visible` axis can't coexist with
  // a `visible` one), so anything positioned outside the dialog's own box
  // becomes reachable only via horizontal scroll, not actually visible.
  // The bare xl dialog (the player-profile modal) is therefore wider than
  // its visible card column, which the caller centers at max-w-3xl inside —
  // the extra width is empty backdrop-click space that gives the ‹ › nav
  // arrows (positioned just outside that inner column) room to render
  // in-bounds instead of being clipped.
  const maxWidth = size === "xl" ? (bare ? "max-w-[64rem]" : "max-w-3xl") : "max-w-lg";

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    // A click that lands on the <dialog> element itself (not any of its
    // children) is a click on the ::backdrop area — <dialog> has no
    // separate hit-testable backdrop node to attach a handler to. In `bare`
    // mode the gaps *between* the stacked cards are also the dialog element
    // itself, so a click in a gap closes too — acceptable, matches ESPN.
    if (e.target === dialogRef.current) onClose();
  }

  if (bare) {
    return (
      <dialog
        ref={dialogRef}
        onClose={onClose}
        onClick={handleBackdropClick}
        aria-label={title}
        className={`m-auto max-h-[92vh] w-full ${maxWidth} overflow-y-auto rounded-lg border-0 bg-transparent p-0 text-foreground backdrop:bg-black/40`}
      >
        {children}
      </dialog>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleBackdropClick}
      className={`m-auto w-full ${maxWidth} rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/40`}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-heading text-sm font-medium">{title}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto">{children}</div>
    </dialog>
  );
}
