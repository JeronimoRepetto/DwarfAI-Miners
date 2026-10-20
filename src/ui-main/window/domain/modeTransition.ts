// Machine 27 of 07, "Mode transition run" (ADR-025 items 1, 3, 8; US-VETA-009; OQ-37 B; owner OQ-78, AMENDMENT-10):
// the transitions 07 lists, as a table. Pure: no I/O, no clock. The `ModeCoordinator` in UI main owns the run
// (`application/ModeCoordinator.ts`); each renderer plays its half; machine 9 carries the chat state and machine 10 is
// the resulting `WindowMode`.
//
// The nodes carry what a run needs to settle: the held mode request (S27.09: the last one wins, it starts its own run
// as S27.01 once this one settles) and the held reveal (S27.14: the latest one wins, applied in the target mode). Both
// survive into the settled node so the coordinator can take them from there.
import type { Outcome, WindowMode } from '@dwarfai/contracts'

/** The transition ids of 07 machine 27. */
export type ModeTransitionId =
  | 'S27.01'
  | 'S27.02'
  | 'S27.03'
  | 'S27.04'
  | 'S27.05'
  | 'S27.06'
  | 'S27.07'
  | 'S27.08'
  | 'S27.09'
  | 'S27.10'
  | 'S27.11'
  | 'S27.12'
  | 'S27.13'
  | 'S27.14'

/** A mode request held during a run (S27.09), named by the transition id it will run under. */
export interface HeldMove {
  mode: WindowMode
  transitionId: string
}

/** One run: its id, its two ends, the renderers that answered `done`, and what it holds. */
export interface ModeRun {
  transitionId: string
  from: WindowMode
  to: WindowMode
  done: readonly ('source' | 'target')[]
  held?: HeldMove
  /** The latest reveal that arrived mid-run (S27.14), by the coordinator's own number for it. */
  heldReveal?: number
}

/** 07 `ModeTransitionState` with what each state carries; `closed` and `lost` are S27.10 and S27.12's `[*]`. */
export type ModeTransitionNode =
  | { state: 'settled'; mode: WindowMode; held?: HeldMove; heldReveal?: number }
  | { state: 'preparing' | 'playing' | 'completing'; run: ModeRun }
  | { state: 'closed'; lastMode: WindowMode }
  | { state: 'lost' }

export type ModeTransitionEvent =
  /** `ipc: moveToMode` from any mode control (S27.01, or S27.09 during a run). */
  | { type: 'move'; mode: WindowMode; transitionId: string }
  /** The target was shown inactive at its final bounds and `mode.transition` went to both renderers (S27.02). */
  | { type: 'prepared' }
  /** Reduced motion: durations 0 ms, the same state transfer (S27.06). */
  | { type: 'reduced-motion' }
  /** The target window cannot be created or shown, or the flush failed (S27.07). */
  | { type: 'target-failed' }
  /** A renderer answered `modeTransitionDone` (A-N15) for this run. */
  | { type: 'done'; role: 'source' | 'target' }
  /** `timer:` the M + 40 ms watchdog (S27.04). */
  | { type: 'watchdog' }
  /** The source hidden and the target focused: the run lands (S27.05). */
  | { type: 'landed' }
  /** The window going hidden mid-motion (S27.08). */
  | { type: 'hidden' }
  /** A click or a key on either window that is not a mode request (S27.09: ignored). */
  | { type: 'input' }
  /** Tray Quit, last window closed, or Stop everything confirmed (S27.10). */
  | { type: 'closed' }
  /** `DwarfDeparted` for the carried chat's dwarf (S27.11). */
  | { type: 'departed' }
  /** The UI process crashed (S27.12). */
  | { type: 'crashed' }
  /** The source and the target are on different displays (S27.13). */
  | { type: 'displays-differ' }
  /** `revealDwarfChat` arrived (S27.14). */
  | { type: 'reveal'; revealId: number }

/** A transition 07 lists: its id and its target. `half-done` is the first of the two answers S27.03 waits for. */
export interface ModeTransitionStep {
  id: ModeTransitionId | 'half-done'
  to: ModeTransitionNode
}

/**
 * Why no transition fires: 07 lists none for this event here; or S27.01's guards — the target mode is not built
 * (BR-19, ADR-034 item 2), or it is the mode already shown (nothing to run).
 */
export type ModeTransitionRefusal = 'not-listed' | 'not-built' | 'already-shown'

const ok = (
  id: ModeTransitionStep['id'],
  to: ModeTransitionNode
): Outcome<ModeTransitionStep, ModeTransitionRefusal> => ({
  ok: true,
  value: { id, to }
})
const refused = (
  error: ModeTransitionRefusal
): Outcome<ModeTransitionStep, ModeTransitionRefusal> => ({
  ok: false,
  error
})

/** The settled node a run leaves in `mode`, keeping what it held. */
function settledIn(mode: WindowMode, run: ModeRun): ModeTransitionNode {
  const node: ModeTransitionNode = { state: 'settled', mode }
  if (run.held !== undefined) node.held = run.held
  if (run.heldReveal !== undefined) node.heldReveal = run.heldReveal
  return node
}

/** The next node of machine 27 from `from` on `event`; `built` lists the modes this build ships (BR-19). */
export function nextModeTransition(
  from: ModeTransitionNode,
  event: ModeTransitionEvent,
  built: readonly WindowMode[]
): Outcome<ModeTransitionStep, ModeTransitionRefusal> {
  if (from.state === 'closed' || from.state === 'lost') return refused('not-listed')
  if (event.type === 'closed') {
    // S27.10: lastMode keeps the source unless S27.03 already ran (the run reached `completing`).
    const lastMode =
      from.state === 'settled'
        ? from.mode
        : from.state === 'completing'
          ? from.run.to
          : from.run.from
    return ok('S27.10', { state: 'closed', lastMode })
  }
  if (event.type === 'crashed') return ok('S27.12', { state: 'lost' })

  if (from.state === 'settled') {
    if (event.type !== 'move') return refused('not-listed')
    if (!built.includes(event.mode)) return refused('not-built')
    if (event.mode === from.mode) return refused('already-shown')
    const run: ModeRun = {
      transitionId: event.transitionId,
      from: from.mode,
      to: event.mode,
      done: []
    }
    if (from.held !== undefined && from.held.transitionId !== event.transitionId)
      run.held = from.held
    if (from.heldReveal !== undefined) run.heldReveal = from.heldReveal
    return ok('S27.01', { state: 'preparing', run })
  }

  const { run } = from
  // S27.09 and S27.14 hold in `preparing` and `playing`; S27.11 completes from either.
  if (from.state === 'preparing' || from.state === 'playing') {
    switch (event.type) {
      case 'move':
        if (!built.includes(event.mode)) return refused('not-built')
        return ok('S27.09', {
          state: from.state,
          run: { ...run, held: { mode: event.mode, transitionId: event.transitionId } }
        })
      case 'input':
        return ok('S27.09', from)
      case 'reveal':
        return ok('S27.14', { state: from.state, run: { ...run, heldReveal: event.revealId } })
      case 'departed':
        return ok('S27.11', { state: 'completing', run })
      default:
        break
    }
  }

  if (from.state === 'preparing') {
    switch (event.type) {
      case 'prepared':
        return ok('S27.02', { state: 'playing', run })
      case 'reduced-motion':
        return ok('S27.06', settledIn(run.to, run))
      case 'target-failed':
        return ok('S27.07', settledIn(run.from, run))
      default:
        return refused('not-listed')
    }
  }

  if (from.state === 'playing') {
    switch (event.type) {
      case 'done': {
        if (run.done.includes(event.role)) return refused('not-listed')
        const done = [...run.done, event.role]
        if (done.length < 2) return ok('half-done', { state: 'playing', run: { ...run, done } })
        return ok('S27.03', { state: 'completing', run: { ...run, done } })
      }
      case 'watchdog':
        return ok('S27.04', { state: 'completing', run })
      case 'hidden':
        return ok('S27.08', settledIn('hidden', run))
      case 'displays-differ':
        return ok('S27.13', from)
      default:
        return refused('not-listed')
    }
  }

  // completing
  return event.type === 'landed' ? ok('S27.05', settledIn(run.to, run)) : refused('not-listed')
}
