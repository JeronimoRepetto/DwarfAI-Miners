// The reopen of UI main (US-RES-003.AC07, UI-main half; UC-001, UC-024; 14 §4.2; ADR-003 item 7): the remembered
// layout and the rehydrated sessions are two parts of one reopen, not a race between them.
//
// - The remembered launch view (the page and the mine the app opens on, A-56 `LaunchView`) is read from the UI
//   preference store first, synchronously, so the first paint never waits for the Host. The mode half of the
//   remembered layout joins with the `lastMode` / `modeAtLaunch` keys of 14 §3.9 (later: ISSUE-060); until then the
//   Panel is the one built mode.
// - The Host attach starts right after it and is never awaited by the start: `HostClient.ensureHost()` attaches to or
//   spawns the Host, and the handler subscribed here receives the board.
// - The board is the last whole snapshot and the seq of the last frame applied on top of it. It changes only when a
//   whole snapshot arrived (HostClient hands one on only once every page arrived), so it is never empty or partial
//   in between: before the first snapshot it is null, and during a re-snapshot it stays the previous one (no flash
//   of an empty board, 14 §4.2; no walk-out from a difference, 14 §4.3 rule 6).
import type { SnapshotPage } from '@dwarfai/contracts'
import type { HostClient, HostEvent } from '../ports/hostClient'
import type { LaunchView, UiPreferenceStore } from '../ports/uiPreferenceStore'

/** The board UI main holds: the last whole snapshot and the seq of the last frame applied on it. */
export interface HostBoardState {
  snapshot: SnapshotPage
  seq: number
}

export interface Reopen {
  /** The remembered page and mine; null when UI main has no preference store composed. */
  readonly launchView: LaunchView | null
  /** The last whole board, or null before the first snapshot arrived. */
  board(): HostBoardState | null
}

export interface ReopenDeps {
  store?: Pick<UiPreferenceStore, 'load'>
  host: Pick<HostClient, 'ensureHost' | 'subscribe'>
}

export function startReopen(deps: ReopenDeps): Reopen {
  const launchView = deps.store?.load('launchView') ?? null
  let board: HostBoardState | null = null
  deps.host.subscribe((event: HostEvent) => {
    if (event.kind === 'snapshot') board = { snapshot: event.snapshot, seq: event.snapshot.seq }
    else if (board !== null) board = { ...board, seq: event.frame.seq }
  })
  void deps.host.ensureHost()
  return { launchView, board: () => board }
}
