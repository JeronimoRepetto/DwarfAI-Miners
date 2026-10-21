/*
 * Veta's overflow, 07 machine 25 (US-VETA-006; UC-049; ISSUE-291): how many chambers the edge holds, the "+N" fold,
 * its hover list, the wheel that cycles the visible run, and the unfold a reveal or a list-item click needs. A
 * renderer presentation state of the session (`06` D-30), never persisted.
 *
 * - The fit (`DS/docs/components.md`, Veta strip, How many chambers fit): the island must fit the available length
 *   along its edge, expand, "+N" and the grip included. From min(4, mines at work) down to 2, the first count whose
 *   run of consecutive chambers fits, else 1; chambers are dropped from the far end of the run, and a sprite is never
 *   scaled to make room (NFR-PERF-07): every length is the chamber's 1:1 length (`islandLength`). An unknown length
 *   (0) draws as many as the cap allows.
 * - The run starts at `first`, the chamber nearest the anchor in mine order; the rest fold into "+N". The wheel moves
 *   it by one chamber per notch, wrapping over the runs that exist, and fits again (crews differ in length, so the
 *   count may change with it). A reveal or a pick moves it just enough for that mine's chamber to be drawn.
 * - Every step that makes the island longer names its growth first (`grow`): the window grows before the run changes
 *   (07 S21.19, S25.03); a shorter island is given back after, by the window hugging what it draws. A reveal or a pick
 *   of a folded mine also names `unfold`, `layoutVeta {unfold-overflow, mineId}` (S25.08, S25.11).
 * - "+N" is never a Tab stop (PO #55): Tab through the strip is no transition (S25.07).
 *
 * It also chooses whose chat a "+N" list-item click opens (S25.11, the `list-shown` invariant; lead decision derived
 * from OQ-76), and debounces the re-measure (`createRemeasure`, S25.03). Pure: no DOM, no clock, no `window.api`; the
 * timers are injected.
 */
import type { DwarfId, DwarfWire, MineId } from '@dwarfai/contracts'
import { BUTTON_ALONG, MORE_ALONG, chamberLength, islandLength } from './island'

/** The most chambers Veta draws (`DS/docs/screens/veta.md`, Numbers written in the scripts: mines shown before +N). */
export const VETA_MAX_CHAMBERS = 4
/** S25.03's debounce: S20.18's 100 ms, so a run of triggers (an arrival, a resize) measures once, the last. */
export const VETA_REMEASURE_DEBOUNCE_MS = 100

export type VetaOverflowState = 'fits' | 'overflowing' | 'list-shown'

export interface VetaOverflow {
  /** `null` until the first measure (`[*]`). */
  readonly state: VetaOverflowState | null
  /** The index, in mine order, of the run's first chamber: the one nearest the anchor. */
  readonly first: number
  /** k, the chambers drawn: 1 ≤ k ≤ 4 while any mine is at work. */
  readonly count: number
}

export const UNMEASURED: VetaOverflow = { state: null, first: 0, count: VETA_MAX_CHAMBERS }

/** What the strip is measured against: each mine's crew in mine order, the length along its edge, its orientation. */
export interface OverflowLayout {
  readonly crews: readonly number[]
  /** The stage's length along the edge, in CSS pixels; 0 when not known. */
  readonly available: number
  /** A left or right edge: the chambers are shafts. */
  readonly vertical: boolean
}

/** A run of consecutive chambers in mine order. */
export interface OverflowRun {
  readonly first: number
  readonly count: number
}

export type OverflowEvent =
  /** `setLength` on show, an edge change, a window resize, a chamber opening or closing (S25.01–S25.03). */
  | { readonly type: 'measure' }
  /** A wheel notch over the strip; its sign is its direction. */
  | { readonly type: 'wheel'; readonly delta: number }
  /** The pointer enters "+N". */
  | { readonly type: 'enter' }
  /** The pointer leaves "+N" and its list. */
  | { readonly type: 'leave' }
  /** Tab through the strip. */
  | { readonly type: 'tab' }
  /** `onRevealDwarfChat` for the mine at this index. */
  | { readonly type: 'reveal'; readonly index: number }
  /** A click on the "+N" list item of the mine at this index. */
  | { readonly type: 'pick'; readonly index: number }

export type OverflowEffect =
  /** `layoutVeta {island-resize}` for this length, answered before the run changes. */
  | { readonly kind: 'grow'; readonly length: number }
  /** `layoutVeta {unfold-overflow, mineId}` for the mine at this index, before the run changes. */
  | { readonly kind: 'unfold'; readonly index: number }

export type OverflowStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      readonly from: VetaOverflowState | null
      readonly to: VetaOverflowState
      /** Carried out in order, before the step's machine is drawn. */
      readonly effects: readonly OverflowEffect[]
    }
  | {
      readonly ok: false
      readonly from: VetaOverflowState | null
      readonly event: OverflowEvent['type']
    }

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high))

/** The run as drawn for `total` mines now, the set having perhaps changed since the last measure. */
export function drawnRun(machine: VetaOverflow, total: number): OverflowRun {
  if (total === 0) return { first: 0, count: 0 }
  const count =
    machine.state === null || machine.state === 'fits'
      ? Math.min(total, VETA_MAX_CHAMBERS)
      : clamp(machine.count, 1, total)
  return { first: clamp(machine.first, 0, total - count), count }
}

/** The island's length along its edge for a run: "+N" counts once anything is folded. */
export function islandOf(layout: OverflowLayout, run: OverflowRun): number {
  return islandLength(
    {
      kind: 'chambers',
      crews: layout.crews.slice(run.first, run.first + run.count),
      folded: run.count < layout.crews.length
    },
    layout.vertical
  )
}

/** The most chambers from `first` that fit (S25.02): at most four, never fewer than one. */
export function fitRun(layout: OverflowLayout, first: number): OverflowRun {
  const total = layout.crews.length
  if (total === 0) return { first: 0, count: 0 }
  const cap = Math.min(VETA_MAX_CHAMBERS, total)
  for (let count = cap; count > 1; count -= 1) {
    const run = { first: clamp(first, 0, total - count), count }
    if (layout.available <= 0 || islandOf(layout, run) <= layout.available) return run
  }
  return { first: clamp(first, 0, total - 1), count: 1 }
}

/** The run that draws the mine at `index`, moved from `from` as little as it takes. */
function runTo(layout: OverflowLayout, from: OverflowRun, index: number): OverflowRun {
  const shifted =
    index < from.first
      ? index
      : index >= from.first + from.count
        ? index - from.count + 1
        : from.first
  const run = fitRun(layout, shifted)
  return index >= run.first && index < run.first + run.count ? run : fitRun(layout, index)
}

interface Next {
  readonly id: string
  readonly run: OverflowRun
  /** The state, when not the one the run gives (`list-shown`). */
  readonly state?: VetaOverflowState
  readonly unfold?: number
}

function transition(
  machine: VetaOverflow,
  event: OverflowEvent,
  layout: OverflowLayout,
  now: OverflowRun
): Next | null {
  const { state } = machine
  const total = layout.crews.length
  switch (event.type) {
    case 'measure': {
      if (state === 'list-shown') return null
      const run = fitRun(layout, now.first)
      if (state === null) return { id: run.count < total ? 'S25.02' : 'S25.01', run }
      return { id: 'S25.03', run }
    }
    case 'wheel': {
      if (state === 'fits') return { id: 'S25.09', run: now }
      if (state !== 'overflowing' || event.delta === 0) return null
      const span = total - now.count + 1
      const first = (now.first + (event.delta > 0 ? 1 : -1) + span) % span
      return { id: 'S25.04', run: fitRun(layout, first) }
    }
    case 'enter':
      return state === 'overflowing' ? { id: 'S25.05', run: now, state: 'list-shown' } : null
    case 'leave':
      return state === 'list-shown' ? { id: 'S25.06', run: now, state: 'overflowing' } : null
    case 'tab':
      return state === 'overflowing' ? { id: 'S25.07', run: now } : null
    case 'reveal': {
      if (state !== 'overflowing' || event.index < 0 || event.index >= total) return null
      const drawn = event.index >= now.first && event.index < now.first + now.count
      if (drawn) return { id: 'S25.08', run: now }
      return { id: 'S25.08', run: runTo(layout, now, event.index), unfold: event.index }
    }
    case 'pick':
      if (state !== 'list-shown' || event.index < 0 || event.index >= total) return null
      return { id: 'S25.11', run: runTo(layout, now, event.index), unfold: event.index }
  }
}

/** One step of machine 25: the next machine, and the transition taken with its effects, or the refusal. */
export function stepOverflow(
  machine: VetaOverflow,
  event: OverflowEvent,
  layout: OverflowLayout
): { machine: VetaOverflow; step: OverflowStep } {
  const total = layout.crews.length
  const now = drawnRun(machine, total)
  const next = transition(machine, event, layout, now)
  if (next === null) return { machine, step: { ok: false, from: machine.state, event: event.type } }
  const to: VetaOverflowState = next.state ?? (next.run.count < total ? 'overflowing' : 'fits')
  const effects: OverflowEffect[] = []
  const length = islandOf(layout, next.run)
  if (machine.state !== null && length > islandOf(layout, now)) {
    effects.push({ kind: 'grow', length })
  }
  if (next.unfold !== undefined) effects.push({ kind: 'unfold', index: next.unfold })
  return {
    machine: { state: to, first: next.run.first, count: next.run.count },
    step: { ok: true, id: next.id, from: machine.state, to, effects }
  }
}

/** The drawn run as the island lays it out, for `chamberAt`. */
export interface DrawnStrip {
  /** The drawn chambers' mines and crews, in mine order. */
  readonly mines: readonly { readonly mineId: MineId; readonly crew: number }[]
  /** Some mine is folded into "+N". */
  readonly folded: boolean
  readonly vertical: boolean
  /** Anchored at the right or bottom end: the parts run grip, "+N", the run nearest the anchor last, expand. */
  readonly anchorEnd: boolean
}

/**
 * The drawn chamber at `along` CSS pixels from the island's start (its left or top edge), or `null` over any other
 * part, from the lengths the island adds up (`islandLength`). After a wheel notch the chamber under a resting pointer
 * is another one, and the risen tab follows it (S25.04 with 07 machine 23: S23.02, or S23.03 over no chamber).
 */
export function chamberAt(strip: DrawnStrip, along: number): MineId | null {
  const more = strip.folded ? MORE_ALONG[strip.vertical ? 'shaft' : 'row'] : 0
  const chambers = strip.anchorEnd ? [...strip.mines].reverse() : strip.mines
  // The island's 2 px padding, then the part before the chambers: the grip and "+N", or expand.
  let at = 2 + (strip.anchorEnd ? BUTTON_ALONG + more : BUTTON_ALONG)
  for (const { mineId, crew } of chambers) {
    const end = at + chamberLength(crew, strip.vertical)
    if (along >= at && along < end) return mineId
    at = end
  }
  return null
}

/** The window's timers, injected. */
export interface RemeasureTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface Remeasure {
  /** Asks for a measure: it runs once, `VETA_REMEASURE_DEBOUNCE_MS` after the last request. */
  request(): void
  cancel(): void
}

/** S25.03: re-measures debounced, so a run of triggers measures once, the last. */
export function createRemeasure(timers: RemeasureTimers, run: () => void): Remeasure {
  let handle: unknown = null
  const cancel = (): void => {
    if (handle !== null) timers.clear(handle)
    handle = null
  }
  return {
    request() {
      cancel()
      handle = timers.set(() => {
        handle = null
        run()
      }, VETA_REMEASURE_DEBOUNCE_MS)
    },
    cancel
  }
}

type CrewMember = Pick<DwarfWire, 'id' | 'status' | 'needsYou' | 'askedAt'>

const needsPerson = (dwarf: CrewMember): boolean => dwarf.needsYou || dwarf.status === 'asking'

/**
 * Whose chat a "+N" list-item click opens (S25.11; lead decision derived from OQ-76, the Valle dive order of S29.12):
 * the dwarf that needs the person, oldest question first; else the one last talked to in that mine; else the first of
 * its crew in crew order; `null` with no dwarf present (`'mine-only'`, S24.16).
 */
export function dwarfToOpen(crew: readonly CrewMember[], talkedTo: DwarfId | null): DwarfId | null {
  const needing = crew
    .map((dwarf, order) => ({ dwarf, order }))
    .filter(({ dwarf }) => needsPerson(dwarf))
    .sort(
      (a, b) =>
        (a.dwarf.askedAt ?? Number.POSITIVE_INFINITY) -
          (b.dwarf.askedAt ?? Number.POSITIVE_INFINITY) || a.order - b.order
    )
  const first = needing[0]
  if (first !== undefined) return first.dwarf.id
  if (talkedTo !== null && crew.some((dwarf) => dwarf.id === talkedTo)) return talkedTo
  return crew[0]?.id ?? null
}
