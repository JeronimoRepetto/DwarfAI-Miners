/*
 * Veta's arrival and departure choreography, 07 machine 26 (US-VETA-007, US-VETA-008; UC-050; ISSUE-292): Veta's own
 * in-world treatment when a dwarf arrives or leaves while Veta is the shown mode. Its inputs are the `dwarf.arrived` and
 * `dwarf.departed` frames alone (ADR-033 item 3): a re-snapshot, silence or a hidden window never walks anyone.
 *
 * - From the closed entrance: the window is first placed for the final island (anchor fixed), the entrance lamp lights
 *   (`lighting`, M = 270 ms), the island is built at its final size with each part fading in from 16 px on the anchor
 *   side, 50 ms apart (`building`), and only then does each dwarf walk in, 70 ms apart (`walking-in`).
 * - Into a drawn chamber: the window grows first, then only that dwarf's button walks in at the chamber's far end.
 * - A mine with no chamber: a new chamber opens last in the mine order (`opening-chamber`), then the walk-in; when four
 *   are drawn or the edge has no room, the mine folds into "+N" and nothing walks (S26.18).
 * - A departure, whatever its cause: the button turns and walks out 14 px away from the anchor while fading
 *   (`walking-out`); an emptied chamber fades out and what lay beyond slides back (`closing-chamber`); with no chamber
 *   left the strip contracts to the closed entrance (`contracting`). The window shrinks after the motion, never during.
 * - Reduced motion (S26.12), the watchdog or the window going hidden (S26.13) apply the end state at once.
 *
 * `stepChoreography` names every step by its 07 id and lists the effects its container carries out, in order; a step 07
 * does not list is refused and the machine is held. The motion table is `DS/docs/motion.md` ("Veta, no sessions →
 * working", "Veta, a dwarf arrives or leaves"): only `transform` and `opacity` move, every entry eases out and every exit
 * eases in, under reduced motion every duration reads 0 ms, and each motion's watchdog fires at its duration + 40 ms.
 * The contraction has no row of its own there: it is the prototype's `showEntrance` after the last chamber closed
 * (`prototype/organisms/veta-strip/veta-strip.js`), the entrance entering where it stands over `--dur-base`.
 *
 * `stageChambers` is the strip the window draws while a choreography runs: the Host's facts, less the arrivals not yet
 * placed and with the departed dwarfs still standing where they stood until they have walked out.
 *
 * Pure: no DOM, no clock, no `window.api`.
 */
import type { DepartureCause, DwarfId, DwarfWire, MineId, MineWire } from '@dwarfai/contracts'
import { chamberLength, islandLength } from './island'
import type { VetaChamberView } from './lifeState'
import { VETA_MAX_CHAMBERS } from './overflow'

export type VetaChoreographyState =
  | 'settled'
  | 'lighting'
  | 'building'
  | 'opening-chamber'
  | 'walking-in'
  | 'walking-out'
  | 'closing-chamber'
  | 'contracting'

export interface VetaChoreography {
  readonly state: VetaChoreographyState
  /** The mine whose dwarfs move; `null` when settled. */
  readonly mineId: MineId | null
  /** The dwarfs walking in (or about to), or the one walking out. */
  readonly dwarfIds: readonly DwarfId[]
  /** The walking-out dwarf was its chamber's last. */
  readonly emptied: boolean
  /** The walking-out dwarf was the last dwarf anywhere. */
  readonly last: boolean
}

export const SETTLED: VetaChoreography = {
  state: 'settled',
  mineId: null,
  dwarfIds: [],
  emptied: false,
  last: false
}

/** Where an arrival lands: the closed entrance, a drawn chamber, a new chamber, or a mine folded into "+N". */
export type ArrivalWhere = 'closed' | 'drawn' | 'new-chamber' | 'folded'

export type ChoreographyEvent =
  /** `dwarf.arrived` (B-F08) of these dwarfs of one mine. */
  | {
      readonly type: 'arrived'
      readonly mineId: MineId
      readonly dwarfIds: readonly DwarfId[]
      readonly where: ArrivalWhere
    }
  /** `dwarf.departed` (B-F10), with what its leaving empties. */
  | {
      readonly type: 'departed'
      readonly mineId: MineId
      readonly dwarfId: DwarfId
      readonly cause: DepartureCause
      /** Its chamber is drawn (not folded into "+N"). */
      readonly drawn: boolean
      /** It was its chamber's last dwarf. */
      readonly emptied: boolean
      /** It was the last dwarf anywhere. */
      readonly last: boolean
    }
  /** The current state's motion finished. */
  | { readonly type: 'done' }
  /** Reduced motion asks for the end state. */
  | { readonly type: 'reduced' }
  /** `timer:` the watchdog at the motion's duration + 40 ms. */
  | { readonly type: 'watchdog' }
  /** The Veta window went hidden. */
  | { readonly type: 'hidden' }
  /** A dwarf has been silent, for any length of time. */
  | { readonly type: 'silence'; readonly dwarfId: DwarfId }

export interface ChoreographyContext {
  /** Veta is the shown mode window. */
  readonly shown: boolean
}

export type ChoreographyEffect =
  /** `layoutVeta {island-resize}` for the final island, before anything grows (anchor fixed). */
  | { readonly kind: 'grow' }
  /** The entrance lamp brightens. */
  | { readonly kind: 'light' }
  /** The island at its final size; its parts fade in from the anchor side. */
  | { readonly kind: 'build' }
  /** A new chamber fades in; what lies beyond it slides by FLIP. */
  | { readonly kind: 'open-chamber'; readonly mineId: MineId }
  /** These dwarfs' buttons walk in on their idle sheets, 70 ms apart. */
  | { readonly kind: 'walk-in'; readonly mineId: MineId; readonly dwarfIds: readonly DwarfId[] }
  /** Arrived: their status sheets start, `start-working` first for a working dwarf. */
  | { readonly kind: 'status-sheet'; readonly dwarfIds: readonly DwarfId[] }
  /** The walk-in in flight resolves at once. */
  | { readonly kind: 'resolve-walk-in'; readonly dwarfIds: readonly DwarfId[] }
  /** The button turns and walks out away from the anchor, fading. */
  | { readonly kind: 'walk-out'; readonly mineId: MineId; readonly dwarfId: DwarfId }
  /** The dwarf's risen chat follows S24.10 / S24.11 for its cause. */
  | { readonly kind: 'chat'; readonly dwarfId: DwarfId; readonly cause: DepartureCause }
  /** The emptied chamber fades out and is removed; then what lay beyond slides back, when anything does. */
  | { readonly kind: 'close-chamber'; readonly mineId: MineId; readonly slideBack: boolean }
  /** The chamber only narrowed: what lies beyond slides back. */
  | { readonly kind: 'slide-back' }
  /** The strip contracts to the closed entrance. */
  | { readonly kind: 'contract' }
  /** `layoutVeta {island-resize}` for the smaller island, once nothing moves. */
  | { readonly kind: 'shrink' }
  /** No choreography: the facts are drawn as they stand. */
  | { readonly kind: 'commit' }
  /** The mine is folded into "+N"; its count updates and nothing walks. */
  | { readonly kind: 'fold'; readonly mineId: MineId }
  /** Every motion in flight ends; the end state shows at once. */
  | { readonly kind: 'end-state' }

export type ChoreographyStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      readonly from: VetaChoreographyState
      readonly to: VetaChoreographyState
      /** Carried out in order. */
      readonly effects: readonly ChoreographyEffect[]
    }
  | { readonly ok: false; readonly from: VetaChoreographyState; readonly event: string }

interface Next {
  readonly id: string
  readonly machine: VetaChoreography
  readonly effects: readonly ChoreographyEffect[]
}

const ANIMATED: ReadonlySet<VetaChoreographyState> = new Set([
  'lighting',
  'building',
  'opening-chamber',
  'walking-in',
  'walking-out',
  'closing-chamber',
  'contracting'
])

function moving(
  state: VetaChoreographyState,
  mineId: MineId,
  dwarfIds: readonly DwarfId[],
  emptied = false,
  last = false
): VetaChoreography {
  return { state, mineId, dwarfIds, emptied, last }
}

/** A departure: its chat first (S24.10 / S24.11), then the walk-out. */
function walkOut(event: Extract<ChoreographyEvent, { type: 'departed' }>): ChoreographyEffect[] {
  return [
    { kind: 'chat', dwarfId: event.dwarfId, cause: event.cause },
    { kind: 'walk-out', mineId: event.mineId, dwarfId: event.dwarfId }
  ]
}

function transition(
  machine: VetaChoreography,
  event: ChoreographyEvent,
  context: ChoreographyContext
): Next | null {
  const { state } = machine
  if (event.type === 'reduced' || event.type === 'watchdog' || event.type === 'hidden') {
    if (!ANIMATED.has(state)) return null
    const id = event.type === 'reduced' ? 'S26.12' : 'S26.13'
    return { id, machine: SETTLED, effects: [{ kind: 'end-state' }, { kind: 'shrink' }] }
  }
  switch (state) {
    case 'settled':
      if (event.type === 'silence') return { id: 'S26.17', machine: SETTLED, effects: [] }
      if (event.type === 'arrived') {
        if (!context.shown) return { id: 'S26.16', machine: SETTLED, effects: [{ kind: 'commit' }] }
        const { mineId, dwarfIds } = event
        switch (event.where) {
          case 'closed':
            return {
              id: 'S26.01',
              machine: moving('lighting', mineId, dwarfIds),
              effects: [{ kind: 'grow' }, { kind: 'light' }]
            }
          case 'drawn':
            return {
              id: 'S26.04',
              machine: moving('walking-in', mineId, dwarfIds),
              effects: [{ kind: 'grow' }, { kind: 'walk-in', mineId, dwarfIds }]
            }
          case 'new-chamber':
            return {
              id: 'S26.05',
              machine: moving('opening-chamber', mineId, dwarfIds),
              effects: [{ kind: 'grow' }, { kind: 'open-chamber', mineId }]
            }
          case 'folded':
            return {
              id: 'S26.18',
              machine: SETTLED,
              effects: [{ kind: 'grow' }, { kind: 'fold', mineId }]
            }
        }
      }
      if (event.type === 'departed') {
        if (!context.shown) {
          return {
            id: 'S26.16',
            machine: SETTLED,
            effects: [
              { kind: 'chat', dwarfId: event.dwarfId, cause: event.cause },
              { kind: 'commit' }
            ]
          }
        }
        if (!event.drawn) return null
        return {
          id: 'S26.07',
          machine: moving('walking-out', event.mineId, [event.dwarfId], event.emptied, event.last),
          effects: walkOut(event)
        }
      }
      return null
    case 'lighting':
      return event.type === 'done'
        ? { id: 'S26.02', machine: { ...machine, state: 'building' }, effects: [{ kind: 'build' }] }
        : null
    case 'building':
    case 'opening-chamber': {
      if (event.type !== 'done' || machine.mineId === null) return null
      return {
        id: state === 'building' ? 'S26.03' : 'S26.05',
        machine: { ...machine, state: 'walking-in' },
        effects: [{ kind: 'walk-in', mineId: machine.mineId, dwarfIds: machine.dwarfIds }]
      }
    }
    case 'walking-in':
      if (event.type === 'done') {
        return {
          id: 'S26.06',
          machine: SETTLED,
          effects: [{ kind: 'status-sheet', dwarfIds: machine.dwarfIds }]
        }
      }
      if (event.type === 'departed' && machine.dwarfIds.includes(event.dwarfId)) {
        return {
          id: 'S26.14',
          machine: moving('walking-out', event.mineId, [event.dwarfId], event.emptied, event.last),
          effects: [{ kind: 'resolve-walk-in', dwarfIds: machine.dwarfIds }, ...walkOut(event)]
        }
      }
      return null
    case 'walking-out':
      if (event.type !== 'done' || machine.mineId === null) return null
      if (machine.emptied) {
        return {
          id: 'S26.08',
          machine: { ...machine, state: 'closing-chamber' },
          effects: [{ kind: 'close-chamber', mineId: machine.mineId, slideBack: !machine.last }]
        }
      }
      return {
        id: 'S26.09',
        machine: SETTLED,
        effects: [{ kind: 'slide-back' }, { kind: 'shrink' }]
      }
    case 'closing-chamber':
      if (event.type !== 'done') return null
      if (machine.last) {
        return {
          id: 'S26.10',
          machine: { ...machine, state: 'contracting' },
          effects: [{ kind: 'contract' }]
        }
      }
      return { id: 'S26.11', machine: SETTLED, effects: [{ kind: 'shrink' }] }
    case 'contracting':
      return event.type === 'done'
        ? { id: 'S26.11', machine: SETTLED, effects: [{ kind: 'shrink' }] }
        : null
  }
}

/** One step of machine 26: the next machine, and the transition taken with its effects, or the refusal. */
export function stepChoreography(
  machine: VetaChoreography,
  event: ChoreographyEvent,
  context: ChoreographyContext
): { machine: VetaChoreography; step: ChoreographyStep } {
  const next = transition(machine, event, context)
  if (next === null) return { machine, step: { ok: false, from: machine.state, event: event.type } }
  return {
    machine: next.machine,
    step: {
      ok: true,
      id: next.id,
      from: machine.state,
      to: next.machine.state,
      effects: next.effects
    }
  }
}

/** `--dur-panel` (`DS/docs/motion.md`, Tokens). */
const DUR_PANEL = 180
/** `--dur-base`. */
const DUR_BASE = 140

/** The motion table (`DS/docs/motion.md`, "Veta, no sessions → working", "Veta, a dwarf arrives or leaves"). */
export const VETA_MOTION = {
  /** The entrance lamp: M = 1.5 × `--dur-panel`. */
  lampMs: 1.5 * DUR_PANEL,
  /** Each part of the island built: from 16 px on the anchor side, 50 ms apart, `--dur-panel` each. */
  part: { fromPx: 16, staggerMs: 50, ms: DUR_PANEL },
  /** A new chamber: from 8 px on the anchor side, `--dur-panel`. */
  chamberOpen: { fromPx: 8, ms: DUR_PANEL },
  /** What lies beyond a chamber that opens, widens, narrows or closes: FLIP, translate only. */
  flipMs: DUR_PANEL,
  /** The arriving dwarf's button: from 14 px away from the anchor, 2 × `--dur-panel`, 70 ms apart. */
  walkIn: { fromPx: 14, ms: 2 * DUR_PANEL, staggerMs: 70 },
  /** The leaving dwarf's button: 14 px away from the anchor, fading, 2 × `--dur-panel`. */
  walkOut: { toPx: 14, ms: 2 * DUR_PANEL },
  /** The emptied chamber fades out, `--dur-panel`. */
  chamberClose: { ms: DUR_PANEL },
  /** The closed entrance enters where it stands, `--dur-base`. */
  contract: { ms: DUR_BASE },
  /** `--ease-out`: every entry. */
  easeOut: 'cubic-bezier(0.2, 0.7, 0.1, 1)',
  /** `--ease-in`: every exit. */
  easeIn: 'cubic-bezier(0.5, 0, 0.9, 0.3)'
} as const

/** Every motion resolves on the first of finishing, its watchdog, or the window going hidden (motion.md, Rules). */
export const VETA_WATCHDOG_MARGIN_MS = 40

/** What a state's motion spans: the island's visible parts, the dwarfs walking, the last chamber closing. */
export interface PhaseCounts {
  readonly parts: number
  readonly walkers: number
  /** The closing chamber was the last: nothing lies beyond to slide back. */
  readonly last?: boolean
}

/** How long a state's whole motion takes, in ms; 0 under reduced motion and when settled. */
export function phaseMs(
  state: VetaChoreographyState,
  counts: PhaseCounts,
  reduced: boolean
): number {
  if (reduced) return 0
  const m = VETA_MOTION
  switch (state) {
    case 'settled':
      return 0
    case 'lighting':
      return m.lampMs
    case 'building':
      return Math.max(0, counts.parts - 1) * m.part.staggerMs + m.part.ms
    case 'opening-chamber':
      return Math.max(m.chamberOpen.ms, m.flipMs)
    case 'walking-in':
      return Math.max(0, counts.walkers - 1) * m.walkIn.staggerMs + m.walkIn.ms
    case 'walking-out':
      return m.walkOut.ms
    case 'closing-chamber':
      return m.chamberClose.ms + (counts.last === true ? 0 : m.flipMs)
    case 'contracting':
      return m.contract.ms
  }
}

/** The state's watchdog: its motion's duration + 40 ms (S26.13; NFR-TIM-16). */
export function watchdogMs(
  state: VetaChoreographyState,
  counts: PhaseCounts,
  reduced: boolean
): number {
  return phaseMs(state, counts, reduced) + VETA_WATCHDOG_MARGIN_MS
}

/** The direction away from the anchor, along the edge: the island grows this way (`outward` in the prototype). */
export interface Outward {
  readonly x: number
  readonly y: number
}

export function outwardOf(vertical: boolean, anchorEnd: boolean): Outward {
  const away = anchorEnd ? -1 : 1
  return vertical ? { x: 0, y: away } : { x: away, y: 0 }
}

export type MotionFrames = readonly Keyframe[]

const px = (n: number): string => `${n === 0 ? 0 : n}px`
const shift = (o: Outward, by: number): string => `translate(${px(o.x * by)}, ${px(o.y * by)})`

/** A part of the island being built: from 16 px on the anchor side. */
export function partFrames(o: Outward): MotionFrames {
  return [
    { opacity: 0, transform: shift(o, -VETA_MOTION.part.fromPx) },
    { opacity: 1, transform: 'none' }
  ]
}

/** A new chamber: from 8 px on the anchor side. */
export function chamberOpenFrames(o: Outward): MotionFrames {
  return [
    { opacity: 0, transform: shift(o, -VETA_MOTION.chamberOpen.fromPx) },
    { opacity: 1, transform: 'none' }
  ]
}

/** The arriving dwarf's button: from 14 px away from the anchor, the chamber's far end. */
export function walkInFrames(o: Outward): MotionFrames {
  return [
    { opacity: 0, transform: shift(o, VETA_MOTION.walkIn.fromPx) },
    { opacity: 1, transform: 'none' }
  ]
}

/** The leaving dwarf's button: to 14 px away from the anchor, fading; held until removed. */
export function walkOutFrames(o: Outward): MotionFrames {
  return [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: shift(o, VETA_MOTION.walkOut.toPx) }
  ]
}

/** FLIP: a part laid out anew plays from where it was (`dx`, `dy` px away) to where it is, translate only. */
export function flipFrames(dx: number, dy: number): MotionFrames {
  return [{ transform: `translate(${px(dx)}, ${px(dy)})` }, { transform: 'none' }]
}

/** An emptied chamber fading out where it stands; held until removed. */
export function fadeOutFrames(): MotionFrames {
  return [{ opacity: 1 }, { opacity: 0 }]
}

/** The closed entrance entering where it stands. */
export function enterFrames(): MotionFrames {
  return [{ opacity: 0 }, { opacity: 1 }]
}

/** A departed dwarf still drawn: its last record, its mine, and where it stood (chamber index, place in the crew). */
export interface Leaving {
  readonly dwarf: DwarfWire
  readonly mine: MineWire
  readonly chamberAt: number
  readonly at: number
}

export interface StageHolds {
  /** Arrived in the facts, not placed in the strip yet. */
  readonly hidden: ReadonlySet<DwarfId>
  /** Departed from the facts, still drawn until they have walked out. */
  readonly leaving: readonly Leaving[]
}

const attentionOf = (dwarfs: readonly DwarfWire[]): boolean =>
  dwarfs.some((d) => d.status === 'asking')

/** The strip to draw: the facts, less the arrivals held back, with the departed dwarfs still where they stood. */
export function stageChambers(
  facts: readonly VetaChamberView[],
  holds: StageHolds
): readonly VetaChamberView[] {
  if (holds.hidden.size === 0 && holds.leaving.length === 0) return facts
  const staged: VetaChamberView[] = []
  for (const chamber of facts) {
    const dwarfs = chamber.dwarfs.filter((d) => !holds.hidden.has(d.id))
    if (dwarfs.length === chamber.dwarfs.length) staged.push(chamber)
    else if (dwarfs.length > 0) staged.push({ ...chamber, dwarfs, attention: attentionOf(dwarfs) })
  }
  for (const gone of holds.leaving) {
    const at = staged.findIndex((c) => c.mine.id === gone.mine.id)
    if (at >= 0) {
      const chamber = staged[at]!
      if (chamber.dwarfs.some((d) => d.id === gone.dwarf.id)) continue
      const dwarfs = [...chamber.dwarfs]
      dwarfs.splice(Math.min(gone.at, dwarfs.length), 0, gone.dwarf)
      staged[at] = { ...chamber, dwarfs, attention: attentionOf(dwarfs) }
    } else {
      const dwarfs = [gone.dwarf]
      staged.splice(Math.min(gone.chamberAt, staged.length), 0, {
        mine: gone.mine,
        dwarfs,
        attention: attentionOf(dwarfs)
      })
    }
  }
  return staged
}

/** The drawn strip a new chamber would join, and the stage's length along the edge (0 when not known). */
export interface ChamberRoom {
  readonly drawnCrews: readonly number[]
  /** A mine is folded into "+N" already. */
  readonly folded: boolean
  readonly available: number
  readonly vertical: boolean
}

/** Whether a new chamber of `crew` dwarfs opens (S26.05) rather than folding into "+N" (S26.18). */
export function opensChamber(room: ChamberRoom, crew: number): boolean {
  if (room.drawnCrews.length >= VETA_MAX_CHAMBERS) return false
  if (room.available <= 0) return true
  const length = islandLength(
    { kind: 'chambers', crews: room.drawnCrews, folded: room.folded },
    room.vertical
  )
  return length + chamberLength(crew, room.vertical) <= room.available
}
