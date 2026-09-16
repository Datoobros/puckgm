"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/Button";

/** Reusable modal dialog — first user is the team page's Notifications
 * button (src/app/leagues/[id]/teams/[teamId]/NotificationsButton.tsx); the
 * backlog's player-profile modal is expected to reuse this same component
 * next, per PROGRESS.md. Built on the native <dialog> element specifically
 * so Esc-to-close and focus containment come for free from the browser
 * instead of being hand-rolled. Light-only theme (no dark: variants), matching
 * the rest of the redesign covered in PROGRESS.md's "UI re-theme" section. */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // A click that lands on the <dialog> element itself (not any of its
        // children) is a click on the ::backdrop area — <dialog> has no
        // separate hit-testable backdrop node to attach a handler to.
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-auto w-full max-w-lg rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/40"
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
