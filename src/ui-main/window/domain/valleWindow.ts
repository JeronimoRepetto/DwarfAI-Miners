// The Valle window (07 machine 39, UI main's half; ADR-025 item 1; ADR-024 item 6; OQ-20; ISSUE-299). Pure: no
// Electron, no I/O, no clock.
//
// - Valle opens on the display matching the window it is entered from (`screen.getDisplayMatching` of the source
//   window's bounds: the display holding most of it), on that display's work area (`VALLE_BOUNDS`). It keeps no
//   placement of its own, per display or otherwise (US-VALLE-001.AC10, PO #85): every entry places it again (S39.01,
//   S39.02).
// - A launch straight into Valle has no source window: the display of the Panel's stored place, else the primary
//   (§24 I-35).
// - A display event while it is shown re-places it on the display now matching its bounds (S39.08, §24 I-37), or refits
//   it to its display's new work area (S39.09).
// - The reveal (S39.06, S39.07) is ISSUE-311's; the stores read before the first paint (S39.03, S39.13) and the on-screen
//   report (S39.05) are the renderer's, named here so the machine is whole.
import type { Outcome } from '@dwarfai/contracts'
import type { DisplayKey, Rect } from '../ports/windowFactory'

/**
 * ADR-025 item 1 (pending design, DG "Valle over or above the taskbar"): `work-area` stops at the taskbar, Dock or
 * panel, which stays visible; `display` would cover it. 14 §3.9 names this constant; until design rules it is the work
 * area.
 */
export type ValleBounds = 'work-area' | 'display'
export const VALLE_BOUNDS: ValleBounds = 'work-area'

/** 07 `ValleWindowState`. */
export type ValleWindowState = 'not-created' | 'hidden' | 'opening' | 'shown' | 'revealing'

/** A node of machine 39. It holds no placement: Valle remembers none (OQ-20). */
export interface ValleNode {
  readonly state: ValleWindowState
}

/** One connected display as Valle reads it (`DisplayInfo`, 16 §4.14). */
export interface ValleDisplay {
  readonly displayKey: DisplayKey
  readonly bounds: Rect
  readonly workArea: Rect
  readonly primary: boolean
}

/** Where Valle is placed: a display and its bounds on it. */
export interface VallePlace {
  readonly displayKey: DisplayKey
  readonly bounds: Rect
}

/** What Valle is entered from: a mode window shown (its bounds), or a launch with no window (§24 I-35). */
export type ValleEntry =
  | { readonly from: 'window'; readonly bounds: Rect }
  | { readonly from: 'launch'; readonly panelPlace: Rect | null }

export type ValleWindowEvent =
  /** S39.03: the stores were read; S39.13 when one of them was unreadable and its defaults apply. */
  | { type: 'stores-read'; unreadable: boolean }
  /** S39.04: leaving Valle (S28.21) or hiding (S10.08). */
  | { type: 'left' }
  /** S39.05: the viewport changed. */
  | { type: 'viewport-changed' }
  /** S39.08: Valle's display was unplugged. */
  | { type: 'display-removed' }
  /** S39.09: a work-area or metrics change. */
  | { type: 'work-area-changed' }
  /** S39.10: Reset metrics. */
  | { type: 'reset' }
  /** S39.11: an observed arrival in a mine not on screen in Valle. */
  | { type: 'arrival-off-screen' }
  /** S39.12: the UI process exits or crashes. */
  | { type: 'ui-exit' }

export interface ValleWindowStep {
  readonly id: string
  readonly to: ValleNode
}

const NOT_LISTED = { ok: false, error: 'not-listed' } as const

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function primaryOf(displays: readonly ValleDisplay[]): ValleDisplay {
  const primary = displays.find((display) => display.primary) ?? displays[0]
  if (primary === undefined) throw new Error('no display to place Valle on')
  return primary
}

/** `screen.getDisplayMatching`: the display holding most of `rect`; none holding any of it is the primary. */
export function displayMatching(rect: Rect, displays: readonly ValleDisplay[]): ValleDisplay {
  let best: ValleDisplay | null = null
  let most = 0
  for (const display of displays) {
    const area = overlap(rect, display.bounds)
    if (area > most) {
      most = area
      best = display
    }
  }
  return best ?? primaryOf(displays)
}

/** Valle's bounds on `display` (`VALLE_BOUNDS`). */
export function valleArea(display: ValleDisplay, bounds: ValleBounds = VALLE_BOUNDS): Rect {
  return { ...(bounds === 'work-area' ? display.workArea : display.bounds) }
}

function placeOn(display: ValleDisplay): VallePlace {
  return { displayKey: display.displayKey, bounds: valleArea(display) }
}

/**
 * S39.01 (from `not-created`) and S39.02 (from `hidden`): Valle is entered, and placed from `entry` alone. An entry in
 * any other state is not a machine 39 row (a move during a run is the coordinator's, S27.09).
 */
export function enterValle(
  node: ValleNode,
  entry: ValleEntry,
  displays: readonly ValleDisplay[]
): Outcome<ValleWindowStep & { place: VallePlace }, 'not-listed'> {
  const id = node.state === 'not-created' ? 'S39.01' : node.state === 'hidden' ? 'S39.02' : null
  if (id === null) return NOT_LISTED
  return { ok: true, value: { id, to: { state: 'opening' }, place: placeValle(entry, displays) } }
}

/** Where an entry places Valle: from `entry` and the displays alone, never from a placement of its own (OQ-20). */
export function placeValle(entry: ValleEntry, displays: readonly ValleDisplay[]): VallePlace {
  const source = entry.from === 'window' ? entry.bounds : entry.panelPlace
  return placeOn(source === null ? primaryOf(displays) : displayMatching(source, displays))
}

/** The step of machine 39 from `from` on `event`, or `not-listed` when 07 lists none. */
export function nextValleWindow(
  from: ValleNode,
  event: ValleWindowEvent
): Outcome<ValleWindowStep, 'not-listed'> {
  const step = (id: string, state: ValleWindowState): Outcome<ValleWindowStep, 'not-listed'> => ({
    ok: true,
    value: { id, to: { state } }
  })
  const { state } = from
  switch (event.type) {
    case 'stores-read':
      if (state !== 'opening') return NOT_LISTED
      return step(event.unreadable ? 'S39.13' : 'S39.03', 'shown')
    case 'left':
      return state === 'shown' ? step('S39.04', 'hidden') : NOT_LISTED
    case 'viewport-changed':
      return state === 'shown' ? step('S39.05', 'shown') : NOT_LISTED
    case 'display-removed':
      return state === 'shown' ? step('S39.08', 'shown') : NOT_LISTED
    case 'work-area-changed':
      return state === 'shown' ? step('S39.09', 'shown') : NOT_LISTED
    case 'reset':
      return state === 'shown' || state === 'hidden' ? step('S39.10', state) : NOT_LISTED
    case 'arrival-off-screen':
      return state === 'shown' ? step('S39.11', 'shown') : NOT_LISTED
    case 'ui-exit':
      return state === 'not-created' ? NOT_LISTED : step('S39.12', 'not-created')
  }
}

/**
 * S39.08, S39.09: after a display event, Valle goes to the display now matching `current` (its bounds), on that
 * display's work area as it is now: the primary when its own display is gone.
 */
export function refitValle(current: Rect, displays: readonly ValleDisplay[]): VallePlace {
  return placeOn(displayMatching(current, displays))
}
