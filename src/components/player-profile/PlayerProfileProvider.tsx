"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { PlayerProfileModal } from "./PlayerProfileModal";

export interface PlayerProfileContextValue {
  openPlayer(playerId: string, nav?: { players: { id: string; fullName: string }[] }): void;
}

const PlayerProfileContext = createContext<PlayerProfileContextValue | null>(null);

interface OpenState {
  playerId: string;
  nav?: { players: { id: string; fullName: string }[] };
}

/** Mounted once per league (src/app/leagues/[id]/layout.tsx) — every
 * `PlayerName` click anywhere inside the league reuses this one modal
 * instance rather than each site owning its own. The modal itself is only
 * rendered while a player is open. */
export function PlayerProfileProvider({ leagueId, children }: { leagueId: string; children: ReactNode }) {
  const [state, setState] = useState<OpenState | null>(null);

  return (
    <PlayerProfileContext.Provider
      value={{
        openPlayer: (playerId, nav) => setState({ playerId, nav }),
      }}
    >
      {children}
      {state && (
        <PlayerProfileModal
          leagueId={leagueId}
          playerId={state.playerId}
          nav={state.nav}
          onNavigate={(id) => setState({ playerId: id, nav: state.nav })}
          onClose={() => setState(null)}
        />
      )}
    </PlayerProfileContext.Provider>
  );
}

export function usePlayerProfile(): PlayerProfileContextValue | null {
  return useContext(PlayerProfileContext);
}
