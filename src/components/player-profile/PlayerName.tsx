"use client";

import type { ReactNode } from "react";
import { usePlayerProfile } from "./PlayerProfileProvider";
import { usePlayerNavList } from "./PlayerNavList";

/** Drop-in replacement for a bare `{fullName}` text node — opens the
 * league's shared player-profile modal on click. Renders as plain text with
 * no `PlayerProfileProvider` in scope (outside a league layout), so it's
 * safe to use anywhere `fullName` was rendered before. */
export function PlayerName({
  playerId,
  fullName,
  className,
  children,
}: {
  playerId: string;
  fullName: string;
  className?: string;
  children?: ReactNode;
}) {
  const profile = usePlayerProfile();
  const navList = usePlayerNavList();

  if (!profile) {
    return <span className={className}>{children ?? fullName}</span>;
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        profile.openPlayer(playerId, navList ? { players: navList.players } : undefined);
      }}
      title={children ? fullName : undefined}
      className={`text-left hover:underline focus-visible:underline ${className ?? ""}`.trim()}
    >
      {children ?? fullName}
    </button>
  );
}
