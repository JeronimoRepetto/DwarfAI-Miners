// Machine 10 of 07, "Window mode ladder and UI process", as the `ModeCoordinator` walks it (ISSUE-284): which mode
// window is shown, `hidden`, windowless `tray-only`, or no UI process at all. Pure: no I/O, no clock. The mode moves
// themselves (S10.04…S10.09, S10.12, S10.13) are carried by machine 27 runs; this table names the rung each one
// reaches. The "Stop everything and quit" overlay (S10.18…S10.21) keeps the underlying rung and is the tray flow's
// (`application/stopEverything.ts`), so it is not a rung here.
import type { Outcome, WindowMode } from '@dwarfai/contracts'

/** A rung of machine 10. */
export type WindowLadderState = 'not-running' | 'tray-only' | WindowMode

type AppMode = Exclude<WindowMode, 'hidden'>

export type WindowLadderEvent =
  /** S10.01: an app launch, per "Mode at launch". */
  | { type: 'launch'; mode: AppMode }
  /** S10.03: started `--background` (by the Host or the OS login entry). */
  | { type: 'background' }
  /** S10.02: a second launch brings the window forward; from `hidden` it shows `lastMode`. */
  | { type: 'second-launch'; lastMode: AppMode }
  /** A machine 27 run landed in `to` (S10.04…S10.09). */
  | { type: 'move'; to: WindowMode }
  /** S10.10: a notification click reveals in the mode shown. */
  | { type: 'reveal' }
  /** From `tray-only`: S10.12 (a notification click, then the reveal) or S10.13 (tray Open, a normal launch). */
  | { type: 'open'; to: AppMode; reveal: boolean }
  /** S10.14: the last window closed. */
  | { type: 'windows-closed' }
  /** S10.15: tray Quit. */
  | { type: 'quit' }
  /** S10.16: the Host closed cleanly. */
  | { type: 'host-closed' }
  /** S10.17: the UI process crashed. */
  | { type: 'crashed' }

export interface WindowLadderStep {
  id: string
  to: WindowLadderState
}

const APP_MODES: readonly WindowLadderState[] = ['panel', 'veta', 'valle']

/** The S10 id of a run from `from` to `to`, or `undefined` when 07 lists none. */
function moveId(
  from: WindowLadderState,
  to: WindowMode,
  built: readonly AppMode[]
): string | undefined {
  if (to !== 'hidden' && !built.includes(to)) return undefined
  if (to === 'hidden') return APP_MODES.includes(from) ? 'S10.08' : undefined
  if (from === 'hidden') return 'S10.09'
  if (from === 'panel' && (to === 'veta' || to === 'valle')) return 'S10.04'
  if (from === 'veta' && to === 'panel') return 'S10.05'
  if (from === 'veta' && to === 'valle') return 'S10.06'
  if (from === 'valle' && (to === 'panel' || to === 'veta')) return 'S10.07'
  return undefined
}

/** The next rung of machine 10 from `from` on `event`; `built` lists the modes this build ships (BR-19). */
export function nextWindowLadder(
  from: WindowLadderState,
  event: WindowLadderEvent,
  built: readonly AppMode[]
): Outcome<WindowLadderStep, 'not-listed'> {
  const step = stepOf(from, event, built)
  return step === undefined ? { ok: false, error: 'not-listed' } : { ok: true, value: step }
}

function stepOf(
  from: WindowLadderState,
  event: WindowLadderEvent,
  built: readonly AppMode[]
): WindowLadderStep | undefined {
  const windowed = from !== 'not-running' && from !== 'tray-only'
  switch (event.type) {
    case 'launch':
      return from === 'not-running' && built.includes(event.mode)
        ? { id: 'S10.01', to: event.mode }
        : undefined
    case 'background':
      return from === 'not-running' ? { id: 'S10.03', to: 'tray-only' } : undefined
    case 'second-launch':
      if (!windowed) return undefined
      return { id: 'S10.02', to: from === 'hidden' ? event.lastMode : from }
    case 'move': {
      const id = moveId(from, event.to, built)
      return id === undefined ? undefined : { id, to: event.to }
    }
    case 'reveal':
      return APP_MODES.includes(from) ? { id: 'S10.10', to: from } : undefined
    case 'open':
      if (from !== 'tray-only' || !built.includes(event.to)) return undefined
      return { id: event.reveal ? 'S10.12' : 'S10.13', to: event.to }
    case 'windows-closed':
      return windowed ? { id: 'S10.14', to: 'tray-only' } : undefined
    case 'quit':
      return windowed ? { id: 'S10.15', to: 'tray-only' } : undefined
    case 'host-closed':
      return from === 'tray-only' ? { id: 'S10.16', to: 'not-running' } : undefined
    case 'crashed':
      return { id: 'S10.17', to: 'not-running' }
  }
}
