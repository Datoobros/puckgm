"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import type { TeamNotification } from "@/lib/notifications/feed";

// Moved here verbatim from page.tsx along with the notification list markup
// it colors — the header's always-visible list is gone, replaced by this
// button + modal (issue #1/#3 in plans/team-page-batch.md).
const NOTIFICATION_DOT: Record<string, string> = {
  TRADE_ACTION: "bg-gold",
  TRADE_PENDING: "bg-blue",
  WAIVER_PENDING: "bg-blue",
  WAIVER_RESULT: "bg-gold",
  FAAB_PENDING: "bg-blue",
  FAAB_RESULT: "bg-gold",
  ROSTER: "bg-danger",
};

/** Header "Notifications (N)" pill — always rendered for a manager, even at
 * zero (one code path, and a small pill at 0 is fine per the plan). Opens a
 * Modal listing everything instead of the old always-visible list that used
 * to sit under the header card. */
export function NotificationsButton({ notifications }: { notifications: TeamNotification[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Notifications ({notifications.length})
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Notifications">
        {notifications.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">Nothing needs your attention right now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {notifications.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${NOTIFICATION_DOT[n.kind]}`} />
                  {n.text}
                </span>
                <Link href={n.href} className="shrink-0 text-xs text-blue hover:underline">
                  View →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
