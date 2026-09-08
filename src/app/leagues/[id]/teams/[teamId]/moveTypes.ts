// Shared between the server (page.tsx, actions.ts) and the client
// (RosterMoveBoard.tsx) — plain types only, no directive, so either side can
// import this without pulling in "use client"/"use server" semantics.

export type MoveSourceTier = "ACTIVE" | "IR";

export type MoveDestinationInput =
  | { kind: "SLOT_EMPTY"; slot: string }
  | { kind: "SLOT_SWAP"; slot: string; displacedPlayerId: string }
  | { kind: "BENCH" }
  | { kind: "IR_PLACE" }
  | { kind: "IR_ACTIVATE_EMPTY"; slot: string }
  | { kind: "IR_ACTIVATE_SWAP"; slot: string; displacedPlayerId: string }
  | { kind: "IR_ACTIVATE_BENCH" };

export interface MoveOption {
  rowKey: string;
  destination: MoveDestinationInput;
}

export interface MoveBoardStatCell {
  key: string;
  value: string;
}

export interface MoveBoardBadge {
  label: string;
  title?: string;
  tone: "muted" | "amber" | "red";
}

// Table rows (Skaters/Goalies) — a mix of real occupants and synthetic empty
// placeholders, already in final display order with divider-group breaks
// computed server-side.
export interface MoveBoardOccupantRow {
  kind: "occupant";
  rowKey: string; // playerId
  slot: string;
  playerId: string;
  fullName: string;
  headshotUrl: string | null;
  currentNhlOrg: string | null;
  badges: MoveBoardBadge[];
  opponentLabel: string;
  locked: boolean;
  statCells: MoveBoardStatCell[];
  canSendToFarm: boolean;
  canDrop: boolean;
  isGroupStart: boolean;
}

export interface MoveBoardEmptyRow {
  kind: "empty";
  rowKey: string;
  slot: string;
  label: string;
  isGroupStart: boolean;
}

export type MoveBoardRow = MoveBoardOccupantRow | MoveBoardEmptyRow;

// IR list rows — simpler, no stats/opponent (matches the existing plain-list
// presentation, not a stats table).
export interface MoveBoardIrOccupantRow {
  kind: "occupant";
  rowKey: string; // playerId
  playerId: string;
  fullName: string;
  headshotUrl: string | null;
  currentNhlOrg: string | null;
  officialRosterStatus: string | null;
  disabledReason: string | null; // shown instead of a Move button when set
}

export interface MoveBoardIrEmptyRow {
  kind: "empty";
  rowKey: string;
}

export type MoveBoardIrRow = MoveBoardIrOccupantRow | MoveBoardIrEmptyRow;
