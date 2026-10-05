// Machine 40 of 07, "Start with the system: the preference and the login entry" (OQ-65; ADR-027 item 7; ADR-024 items
// 1, 2): the transitions 07 lists, as a table. Pure: no I/O, no clock. Who owns what: UI main (window module) stores
// `startWithSystem` and writes the entry through `AutostartPort`; the Host never reads it.
import type { Outcome } from '@dwarfai/contracts'

/** 07 §0 `StartWithSystemState`. */
export type StartWithSystemState = 'on' | 'off' | 'applying'

/** A machine-40 state with what `applying` carries: the value being applied and whether a person's action started it. */
export type StartWithSystemNode =
  { state: 'on' } | { state: 'off' } | { state: 'applying'; target: boolean; asked: boolean }

export type StartWithSystemEvent =
  /** UI main starts (S10.01 or S10.03). */
  | { type: 'start' }
  /** `UI:` the toggle → A-N21 `setUiPreference({key:'startWithSystem', value})`. */
  | { type: 'toggled'; value: boolean }
  /** `AutostartPort.set(target)` returned (`threw` = it threw), then `get()` read `readBack`. */
  | { type: 'applied'; threw: boolean; readBack: boolean }
  /** The UI process crashed while applying. */
  | { type: 'crashed' }
  /** `ui.resetPreferences` (`asked` for the window that ran the reset) or a newer `resetEpoch` at attach. */
  | { type: 'reset'; asked: boolean }
  /** The person logs into the OS. */
  | { type: 'os-login' }
  /** An uninstall hook or the manual `--revert-integrations`. */
  | { type: 'uninstalled' }

export type StartWithSystemTransitionId =
  | 'S40.01'
  | 'S40.02'
  | 'S40.03'
  | 'S40.04'
  | 'S40.05'
  | 'S40.06'
  | 'S40.07'
  | 'S40.08'
  | 'S40.09'
  | 'S40.10'
  | 'S40.11'
  | 'S40.12'
  | 'S40.13'

/** A transition 07 lists: its id and its target; `null` is `[*]` (S40.09, nothing stored). */
export interface StartWithSystemStep {
  id: StartWithSystemTransitionId
  to: StartWithSystemNode | null
}

const on: StartWithSystemNode = { state: 'on' }
const off: StartWithSystemNode = { state: 'off' }
const valueNode = (value: boolean): StartWithSystemNode => (value ? on : off)
const applying = (target: boolean, asked: boolean): StartWithSystemNode => ({
  state: 'applying',
  target,
  asked
})

/**
 * The step out of `applying` once the write returned and the entry was read back (S40.05…S40.08): the read-back is
 * the next node, never the target (ADR-027 item 7, "apply, then verify").
 *
 * S40.08 is the case 07 draws as `on → off` at a start: an entry the person disabled in the OS's startup list. The
 * frozen `AutostartPort` (16 §4.14) tells it only by its read-back — a write of ON at a start that returned, after
 * which the entry still does not start the app (the adapter never re-enables an entry disabled in the OS list, so
 * nothing was written) — so it is taken here, out of the start's `applying`, to the same `off`.
 */
function applied(
  target: boolean,
  asked: boolean,
  threw: boolean,
  readBack: boolean
): StartWithSystemStep {
  if (!threw && readBack === target) return { id: 'S40.05', to: valueNode(target) }
  if (asked) return { id: 'S40.06', to: valueNode(readBack) }
  if (target && !threw) return { id: 'S40.08', to: off }
  return { id: 'S40.07', to: valueNode(readBack) }
}

/** The next node of machine 40 from `from` (`undefined` = `[*]`, nothing stored yet) on `event`. */
export function nextStartWithSystem(
  from: StartWithSystemNode | undefined,
  event: StartWithSystemEvent
): Outcome<StartWithSystemStep, 'not-listed'> {
  const step = stepOf(from, event)
  return step === undefined ? { ok: false, error: 'not-listed' } : { ok: true, value: step }
}

function stepOf(
  from: StartWithSystemNode | undefined,
  event: StartWithSystemEvent
): StartWithSystemStep | undefined {
  if (from === undefined) {
    // S40.01: the first start of a fresh install; the default is ON.
    return event.type === 'start' ? { id: 'S40.01', to: applying(true, false) } : undefined
  }
  if (from.state === 'applying') {
    switch (event.type) {
      case 'applied':
        return applied(from.target, from.asked, event.threw, event.readBack)
      case 'crashed':
        // S40.09: nothing stored; the next start re-applies the stored value.
        return { id: 'S40.09', to: null }
      case 'reset':
        // S40.10: a running apply finishes first, then ON is applied.
        return { id: 'S40.10', to: applying(true, event.asked) }
      default:
        return undefined
    }
  }
  const value = from.state === 'on'
  switch (event.type) {
    case 'start':
      // S40.02: the stored value, re-applied idempotently.
      return { id: 'S40.02', to: applying(value, false) }
    case 'toggled':
      // S40.03 (ON → OFF), S40.04 (OFF → ON): the toggle only ever asks for the other value.
      if (event.value === value) return undefined
      return { id: value ? 'S40.03' : 'S40.04', to: applying(event.value, true) }
    case 'reset':
      return { id: 'S40.10', to: applying(true, event.asked) }
    case 'os-login':
      // S40.11: the entry starts the app `--background`; S40.12: nothing starts.
      return { id: value ? 'S40.11' : 'S40.12', to: from }
    case 'uninstalled':
      // S40.13: the entry is removed whatever the setting; the preference file is user data and stays.
      return { id: 'S40.13', to: from }
    default:
      return undefined
  }
}
