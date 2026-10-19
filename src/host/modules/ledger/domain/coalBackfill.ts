// Machine 19, the coal backfill (07 §19; 06 §0 `CoalBackfillState`, `CoalBackfillProgress`,
// `BackfillReport`; 09 §5.5). Pure: no I/O, no clock read (05 §2.2, R1).
//
// The state is stored as `install_moment.backfill_state` (one set in every document, 07 M-06). No
// install moment (`null` here) is the machine's initial pseudo-state: between a reset's `db` and
// `install-moment` steps there is no row, and writing one starts the machine at `not-started`
// (S19.01) with empty progress (the old moment's scan units went with it, by cascade).
import type { Instant } from '../../../kernel/domain/values'

/** 06 §0 `CoalBackfillState` (= 09 `install_moment.backfill_state`). */
export type CoalBackfillState = 'not-started' | 'running' | 'paused' | 'done'

/**
 * 06 §0 `CoalBackfillProgress`: the state, the scan units already finished for the current install
 * moment (`coal_backfill_units.scan_unit`), and when the scan finished (`backfill_done_at`, set
 * exactly when `done`, the table CHECK).
 */
export interface CoalBackfillProgress {
  state: CoalBackfillState
  creditedScanUnits: string[]
  doneAt?: Instant
}

/**
 * 06 §0 `BackfillReport` (today's `CoalBackfillResult`, `coalBackfill.ts:100` at `0bfd108`): what
 * one run did. Package gap: 05 §3.10 references the type without fields; these are the
 * transplanted result's counts, per scan unit and per credited unit, plus why a run did not start.
 */
export interface BackfillReport {
  /**
   * `done`: the scan is complete (S19.05); `paused`: the per-boot budget was reached (S19.03);
   * `aborted`: a Reset metrics ended the run (S19.06); `not-run`: a gate kept it from starting.
   */
  outcome: 'done' | 'paused' | 'aborted' | 'not-run'
  /** Why a run did not start; present only for `not-run`. */
  notRunReason?: 'no-install-moment' | 'reset-in-progress' | 'already-done'
  /** Scan units finished and recorded by this run. */
  scanUnits: number
  /** Usage units credited as coal by this run. */
  unitsCredited: number
  /** Coal tokens credited by this run. */
  tokensCredited: number
  /** Scan units skipped this run because they could not be read (S19.08). */
  unreadableUnits: number
}

/** What drives machine 19. `ready` carries its guard: no reset saga is unfinished. */
export type CoalBackfillEvent =
  | { type: 'moment-written' }
  | { type: 'ready'; resetSagaDone: boolean }
  | { type: 'budget-reached' }
  | { type: 'complete' }
  | { type: 'reset' }
  | { type: 'unit-unreadable' }

/** The transition ids of 07 §19. */
export type CoalBackfillTransitionId =
  'S19.01' | 'S19.02' | 'S19.03' | 'S19.04' | 'S19.05' | 'S19.06' | 'S19.07' | 'S19.08'

export type CoalBackfillTransition =
  | { ok: true; id: CoalBackfillTransitionId; to: CoalBackfillState }
  | { ok: false; reason: 'not-listed' | 'guard' }

/**
 * One step of machine 19 from `from` (`null`: no install moment). A pair 07 §19 does not list is
 * rejected (`not-listed`); a listed `ready` whose guard fails (a reset saga is unfinished) is
 * rejected (`guard`) and the state stays.
 */
export function stepCoalBackfill(
  from: CoalBackfillState | null,
  event: CoalBackfillEvent
): CoalBackfillTransition {
  switch (event.type) {
    case 'moment-written':
      // S19.01: `[*]` (no moment) and `done` (the diagram: a Reset metrics writes a new moment).
      return from === null || from === 'done' ? to('S19.01', 'not-started') : notListed()
    case 'ready':
      if (from === 'running') return to('S19.07', 'running')
      if (from !== 'not-started' && from !== 'paused') return notListed()
      if (!event.resetSagaDone) return { ok: false, reason: 'guard' }
      return to(from === 'not-started' ? 'S19.02' : 'S19.04', 'running')
    case 'budget-reached':
      return from === 'running' ? to('S19.03', 'paused') : notListed()
    case 'complete':
      return from === 'running' ? to('S19.05', 'done') : notListed()
    case 'reset':
      return from === 'running' || from === 'paused' ? to('S19.06', 'not-started') : notListed()
    case 'unit-unreadable':
      return from === 'running' ? to('S19.08', 'running') : notListed()
  }
}

function to(id: CoalBackfillTransitionId, state: CoalBackfillState): CoalBackfillTransition {
  return { ok: true, id, to: state }
}

function notListed(): CoalBackfillTransition {
  return { ok: false, reason: 'not-listed' }
}
