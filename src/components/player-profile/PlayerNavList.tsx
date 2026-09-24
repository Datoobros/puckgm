"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface PlayerNavListValue {
  players: { id: string; fullName: string }[];
}

const PlayerNavListContext = createContext<PlayerNavListValue | null>(null);

/** Wraps a list-rendering component (Players page table, roster board, …)
 * so the `PlayerName` opened from any row inside it gets ‹ › arrows over
 * the list's own rendered order (post sort/filter/paging). Sites with no
 * wrapper open the profile modal with no arrows. */
export function PlayerNavList({
  players,
  children,
}: {
  players: { id: string; fullName: string }[];
  children: ReactNode;
}) {
  return <PlayerNavListContext.Provider value={{ players }}>{children}</PlayerNavListContext.Provider>;
}

export function usePlayerNavList(): PlayerNavListValue | null {
  return useContext(PlayerNavListContext);
}
