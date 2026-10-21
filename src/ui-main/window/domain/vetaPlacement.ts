// Where Veta's island sits (07 machine 21, UI main's half; US-VETA-002; ADR-024 items 1, 5, 8; ADR-025 items 2, 5;
// `DS/docs/screens/veta.md` Layout). Pure: no Electron, no I/O, no clock.
//
// - A place is a `VetaDock {edge, end, offset}` on one display's work area (14 §3.9): `end` names the end of that edge
//   the island is anchored at (`start` = left on a top or bottom edge, top on a side edge; `end` = right or bottom),
//   and `offset` is the distance from that end to the island. The island grows away from its anchor, never toward it.
// - The window hugs the island flush against the work area (the taskbar, Dock or panel is never covered): horizontal on
//   a top or bottom edge, vertical on a side edge (US-VETA-002.AC08). On an edge shorter than the island the grip end
//   stays on screen and the anchor end (expand) runs off (US-VETA-002.AC06, decision "Veta on a short edge").
// - The default place (S21.02): the bottom edge, at the end on the Panel's dock side, 16 px along it, on the primary
//   display.
// - `vetaDock` holds one entry per display ever used (UC-045 postconditions). The entry saved last is the display Veta
//   lives on: a save moves its key to the end, and a show restores the last stored entry whose display is connected
//   (S21.01). That order is the only "where was it last" the store keeps (package gap, ISSUE-286 hand-off).
import type { VetaDock } from '@dwarfai/contracts'
import type { DisplayKey, Rect } from '../ports/windowFactory'
import { matchDisplayKey } from './displayKey'

/** One connected display as the dock reads it (`DisplayInfo`, 16 §4.14). */
export interface VetaDisplay {
  readonly displayKey: DisplayKey
  readonly bounds: Rect
  readonly workArea: Rect
  readonly primary: boolean
}

/** Machine 21's UI-main states that hold a place: `docked`, or `fallback` (no stored display connected). */
export interface VetaPlace {
  readonly kind: 'docked' | 'fallback'
  readonly displayKey: DisplayKey
  readonly dock: VetaDock
}

/** `UiPreferencesMap.vetaDock` (14 §3.9): the stored places, keyed by `displayKey`, the last one saved last. */
export type VetaDocks = Readonly<Record<DisplayKey, VetaDock>>

/** The Panel's docking edge (`dockSide`, ADR-024 item 1): the end of the bottom edge Veta's default place takes. */
export type PanelSide = 'left' | 'right'

/** The island's size along its edge (`length`) and across it (`thickness`). */
export interface IslandExtent {
  readonly length: number
  readonly thickness: number
}

/** 14 §3.9 `VetaDockChanged.reason`: why UI main re-placed Veta (A-N28). */
export type VetaDockChangeReason = 'display-removed' | 'display-changed' | 'work-area-changed'

type Edge = VetaDock['edge']

/** S21.02: 16 px along the bottom edge from the end on the Panel's dock side. */
export const VETA_DEFAULT_OFFSET = 16

/** S21.02: the bottom edge, at the end on the Panel's dock side, 16 px along it. */
export function defaultVetaDock(side: PanelSide): VetaDock {
  return { edge: 'bottom', end: side === 'left' ? 'start' : 'end', offset: VETA_DEFAULT_OFFSET }
}

/** A side edge holds the island vertical (US-VETA-002.AC08). */
export function isVerticalEdge(edge: Edge): boolean {
  return edge === 'left' || edge === 'right'
}

const edgeLength = (area: Rect, edge: Edge): number =>
  isVerticalEdge(edge) ? area.height : area.width

/** The offset that keeps an island of `length` on its edge; 0 when it is longer than the edge. */
function clampOffset(offset: number, edge: number, length: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, edge - length)))
}

/** The edge of `area` nearest `p` (ties: bottom, top, left, right); a point outside counts as on that edge. */
export function nearestEdge(area: Rect, p: { x: number; y: number }): Edge {
  const distance: [Edge, number][] = [
    ['bottom', area.y + area.height - p.y],
    ['top', p.y - area.y],
    ['left', p.x - area.x],
    ['right', area.x + area.width - p.x]
  ]
  let best = distance[0]!
  for (const entry of distance) if (Math.max(0, entry[1]) < Math.max(0, best[1])) best = entry
  return best[0]
}

/**
 * S21.08: the place a release at `p` lands on: the edge nearest the pointer; the end is the half of that edge the
 * pointer is in; the offset is measured from that end, centred on the pointer and clamped to the work area.
 */
export function dockAtPointer(area: Rect, p: { x: number; y: number }, length: number): VetaDock {
  const edge = nearestEdge(area, p)
  const span = edgeLength(area, edge)
  const raw = isVerticalEdge(edge) ? p.y - area.y : p.x - area.x
  const along = Math.max(0, Math.min(raw, span))
  const end = along < span / 2 ? 'start' : 'end'
  const fromEnd = end === 'start' ? along : span - along
  return { edge, end, offset: clampOffset(Math.round(fromEnd - length / 2), span, length) }
}

/** S21.11: the named edge, the same end and offset, clamped to the new edge. */
export function dockToEdge(dock: VetaDock, edge: Edge, area: Rect, length: number): VetaDock {
  return { edge, end: dock.end, offset: clampOffset(dock.offset, edgeLength(area, edge), length) }
}

/**
 * The window's bounds: the island flush against `dock.edge` of the work area, `dock.offset` from `dock.end` (clamped
 * so it stays on screen), vertical on a side edge; on an edge shorter than the island the grip end (the far end from
 * the anchor) is flush with the work area and the anchor end runs off (S21.19, US-VETA-002.AC06).
 */
export function vetaBounds(area: Rect, dock: VetaDock, island: IslandExtent): Rect {
  const vertical = isVerticalEdge(dock.edge)
  const span = edgeLength(area, dock.edge)
  const origin = vertical ? area.y : area.x
  const { length, thickness } = island
  let along: number
  if (length > span) {
    // Anchored at the start, the grip is at the far end: that end meets the work area's far side.
    along = dock.end === 'start' ? origin + span - length : origin
  } else {
    const offset = clampOffset(dock.offset, span, length)
    along = dock.end === 'start' ? origin + offset : origin + span - offset - length
  }
  if (vertical) {
    const x = dock.edge === 'left' ? area.x : area.x + area.width - thickness
    return { x, y: along, width: thickness, height: length }
  }
  const y = dock.edge === 'top' ? area.y : area.y + area.height - thickness
  return { x: along, y, width: length, height: thickness }
}

/** S21.09, S21.11, S21.15: `dock` saved under `key`, which becomes the last one saved. */
export function storeVetaDock(stored: VetaDocks, key: DisplayKey, dock: VetaDock): VetaDocks {
  const next: Record<DisplayKey, VetaDock> = {}
  for (const [k, v] of Object.entries(stored)) if (k !== key) next[k] = v
  next[key] = { ...dock }
  return next
}

/** The primary display (or the first listed, when none says so). */
function primaryOf(displays: readonly VetaDisplay[]): VetaDisplay {
  const primary = displays.find((display) => display.primary) ?? displays[0]
  if (primary === undefined) throw new Error('no display to place Veta on')
  return primary
}

/**
 * S21.01–S21.03: where a shown Veta goes. The last stored entry whose display is connected (matched fuzzily, ADR-024
 * item 5); with no stored place, the default place on the primary display (`docked`); with stored places none of
 * which is connected, the same default place in `fallback`, the entries kept.
 */
export function placeOnShow(
  stored: VetaDocks,
  displays: readonly VetaDisplay[],
  side: PanelSide
): VetaPlace {
  const entries = Object.entries(stored)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, dock] = entries[i]!
    const match = matchDisplayKey(key, displays)
    if (match !== null) return { kind: 'docked', displayKey: match, dock: { ...dock } }
  }
  return {
    kind: entries.length === 0 ? 'docked' : 'fallback',
    displayKey: primaryOf(displays).displayKey,
    dock: defaultVetaDock(side)
  }
}

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * S21.12–S21.14: what a `display:` event does to the current place. `previousArea` is the work area Veta was last
 * placed against. Veta's display gone: the default place on the primary display, in `fallback` (S21.13); in
 * `fallback`, a display whose key matches a stored entry: back to that place (S21.14); Veta's display re-keyed (its
 * scale or its place beside the primary display changed): the same place on it; its work area changed: the same place,
 * flush against the new work area (S21.12). The stored entries are never changed here. `reason` is null when nothing
 * moved, else A-N28's.
 */
export function placeOnDisplayChange(
  current: VetaPlace,
  previousArea: Rect,
  stored: VetaDocks,
  displays: readonly VetaDisplay[],
  side: PanelSide
): { place: VetaPlace; reason: VetaDockChangeReason | null } {
  const areaOf = (key: DisplayKey): Rect | undefined =>
    displays.find((display) => display.displayKey === key)?.workArea
  if (current.kind === 'fallback') {
    const next = placeOnShow(stored, displays, side)
    if (next.kind === 'docked' || next.displayKey !== current.displayKey) {
      return { place: next, reason: 'display-changed' }
    }
    const area = areaOf(next.displayKey)
    return {
      place: current,
      reason: area !== undefined && !sameRect(area, previousArea) ? 'work-area-changed' : null
    }
  }
  const match = matchDisplayKey(current.displayKey, displays)
  if (match === null) {
    return {
      place: {
        kind: 'fallback',
        displayKey: primaryOf(displays).displayKey,
        dock: defaultVetaDock(side)
      },
      reason: 'display-removed'
    }
  }
  if (match !== current.displayKey) {
    return { place: { ...current, displayKey: match }, reason: 'display-changed' }
  }
  const area = areaOf(match)
  return {
    place: current,
    reason: area !== undefined && !sameRect(area, previousArea) ? 'work-area-changed' : null
  }
}

/**
 * S21.09 / S21.20: a landing (or a keyboard dock, S21.11) applied moves to the asked place and saves it under its
 * display's key; refused, the place before the press stands and nothing is saved.
 */
export function land(
  before: VetaPlace,
  asked: VetaPlace,
  stored: VetaDocks,
  applied: boolean
): { place: VetaPlace; stored: VetaDocks } {
  if (!applied) return { place: before, stored }
  return {
    place: { kind: 'docked', displayKey: asked.displayKey, dock: asked.dock },
    stored: storeVetaDock(stored, asked.displayKey, asked.dock)
  }
}

/**
 * S21.17 (ADR-024 item 8; PO #80): Reset metrics rewrites every entry to the default, which is no stored place at all:
 * every display then takes the default place (S21.02 "after Reset metrics").
 */
export function resetVetaDocks(_stored: VetaDocks): VetaDocks {
  return {}
}
