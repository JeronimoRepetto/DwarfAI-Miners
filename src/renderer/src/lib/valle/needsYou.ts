import type { AskState, DwarfId, MineId } from '@dwarfai/contracts'
import type { VallePreset } from './preset'

/*
 * 07 machine 34 `NeedsYouCounterState` (VA6, the needs-you queue and the "Need you ▸" counter; UC-059; US-VALLE-004,
 * US-VALLE-012; ISSUE-306): the words and accessible names of the top bar's counter and of the footer's row, the Host
 * queue patched in place as asks open and close, and where a press jumps in the preset shown.
 *
 * - The queue is the Host's `NeedsYouQueue` (06 §0.2; 14 §4.1 snapshot `asks`): one entry per dwarf with an open ask,
 *   ordered by `askedAt`, its oldest live ask's `openedAt` (ADR-032 D6). It is taken as it comes and never re-sorted or
 *   derived here (ADR-033 item 3): a frame appends a new asker at the end (S34.02, the Host's own newest), drops an entry
 *   whose dwarf has no ask left (S34.03), or, when the same dwarf's next ask becomes current, moves that one entry to
 *   the place its next ask's `askedAt` takes in the Host's order (S34.04). Every other entry stays the same object, in
 *   the same place, so the row patches in place (NFR-PERF-03).
 * - A press never changes the preset (US-VALLE-004.AC01, US-VALLE-012.AC02): the jump names the preset it answers in.
 *   The counter goes to the oldest entry (S34.05, S34.06); an entry to its own dwarf (S34.07), whose chat still opens
 *   when its ask closed meanwhile and the dwarf is present (S34.11).
 * - The words are the design's (`DS/docs/copy.md`, Valle top bar and Needs-you queue; decision log, "Needs-you count
 *   wording"; BR-12). The counter's accessible name counts and never names a dwarf (US-VALLE-004.AC07); an entry's
 *   spells out the dwarf and the mine, never the mark alone (US-VALLE-012.AC07).
 */

export type NeedsYouState = 'nobody-waiting' | 'waiting'

/** One entry of the Host's `NeedsYouQueue` (06 §0.2). */
export interface NeedsYouEntry {
  readonly dwarfId: DwarfId
  readonly mineId: MineId
  readonly askedAt: number
}

/** The Host's queue, in its order. */
export type NeedsYouQueue = readonly NeedsYouEntry[]

/** `DS/docs/copy.md`, Valle top bar: the counter's title. */
export const COUNTER_TITLE = 'Jump to the next dwarf waiting on you'
/** `DS/docs/copy.md`, Needs-you queue: the strip's label and accessible name. */
export const QUEUE_LABEL = 'Needs you'
/** `DS/docs/copy.md`, Needs-you queue: shown in place of the entries (US-VALLE-012.AC06). */
export const QUEUE_EMPTY_TEXT = 'Nobody is waiting on you.'

/** What the counter shows. */
export interface CounterView {
  readonly state: NeedsYouState
  readonly count: number
  /** "1 needs you", "`<n>` need you" or "Nobody waiting" (BR-12). */
  readonly text: string
  /** Counts, names no dwarf (US-VALLE-004.AC07). */
  readonly label: string
  readonly disabled: boolean
}

/** What an entry's words read of the Host's facts. */
export interface EntryFacts {
  /** The dwarf's shown name (`customName ?? baseName`). */
  name(dwarfId: DwarfId): string
  mineName(mineId: MineId): string
  /** The kind of the dwarf's current (oldest open) ask. */
  askOf(dwarfId: DwarfId): 'question' | 'permission' | null
}

/** What one entry of the row shows. */
export interface EntryView {
  readonly dwarfId: DwarfId
  readonly mineId: MineId
  /** "?" a question, "!" a permission. */
  readonly mark: '?' | '!'
  readonly name: string
  /** The mine, after "permission · " for a permission. */
  readonly where: string
  /** "`<dwarf>` asks for a permission in `<mine>`" or "`<dwarf>` has a question in `<mine>`". */
  readonly label: string
}

export type NeedsYouInput =
  /** Valle shown, or a re-snapshot: the Host's queue as it comes (S34.01). */
  | { readonly kind: 'snapshot'; readonly queue: NeedsYouQueue }
  /** B-F15 `ask.opened` for a dwarf the crew knows on `mineId` (S34.02). */
  | {
      readonly kind: 'ask-opened'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly askedAt: number
      readonly state: AskState
    }
  /** B-F16 `ask.closed`: `next` is the `openedAt` of the dwarf's next open ask, `null` with none left (S34.03, S34.04). */
  | { readonly kind: 'ask-closed'; readonly dwarfId: DwarfId; readonly next: number | null }
  /** B-F10 `dwarf.departed` (S34.03). */
  | { readonly kind: 'departed'; readonly dwarfId: DwarfId }
  /** `UI:` the counter pressed (S34.05, S34.06, S34.08). */
  | { readonly kind: 'counter'; readonly preset: VallePreset; readonly frontMine: MineId | null }
  /** `UI:` an entry pressed, as the row drew it (S34.07, S34.11). */
  | {
      readonly kind: 'entry'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly preset: VallePreset
      readonly frontMine: MineId | null
      /** The dwarf is still present (S34.11). */
      readonly present: boolean
    }
  /** A preset switch (S34.09). */
  | { readonly kind: 'preset-switch' }

/**
 * Where a press answers, in the preset shown, which never changes: the Control room pins and expands the dwarf's chat,
 * adds and scrolls to its mine's column and makes it current, its zone outlined with the call ring (S34.05; S29.19,
 * S32.14, S35.01); the Work front swaps to its mine when it differs (S28.15, no dive), then selects its tab (S34.06).
 */
export type JumpTarget =
  | { readonly preset: 'control'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  | {
      readonly preset: 'front'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly swap: boolean
    }

export type NeedsYouStep =
  | {
      readonly ok: true
      readonly id: string
      readonly queue: NeedsYouQueue
      readonly jump: JumpTarget | null
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

const REFUSED: NeedsYouStep = { ok: false, reason: 'not-listed' }

/** An ask still waiting for the person (ADR-010 item 5). */
const isOpen = (state: AskState): boolean => state === 'open' || state === 'answering'

export const needsYouState = (queue: NeedsYouQueue): NeedsYouState =>
  queue.length === 0 ? 'nobody-waiting' : 'waiting'

/** The counter's words (BR-12; `DS/docs/copy.md`, Valle top bar). */
export function counterView(queue: NeedsYouQueue): CounterView {
  const count = queue.length
  if (count === 0) {
    return {
      state: 'nobody-waiting',
      count,
      text: 'Nobody waiting',
      label: 'Nobody is waiting on you',
      disabled: true
    }
  }
  return {
    state: 'waiting',
    count,
    text: count === 1 ? '1 needs you' : `${count} need you`,
    label: `${count} waiting on you. Jump to the next one`,
    disabled: false
  }
}

/** One entry's words (`DS/docs/copy.md`, Needs-you queue; `DS/docs/accessibility.md`). */
export function entryView(entry: NeedsYouEntry, facts: EntryFacts): EntryView {
  const name = facts.name(entry.dwarfId)
  const mine = facts.mineName(entry.mineId)
  const permission = facts.askOf(entry.dwarfId) === 'permission'
  return {
    dwarfId: entry.dwarfId,
    mineId: entry.mineId,
    mark: permission ? '!' : '?',
    name,
    where: permission ? `permission · ${mine}` : mine,
    label: permission
      ? `${name} asks for a permission in ${mine}`
      : `${name} has a question in ${mine}`
  }
}

function jumpOf(
  dwarfId: DwarfId,
  mineId: MineId,
  preset: VallePreset,
  frontMine: MineId | null
): JumpTarget {
  return preset === 'control'
    ? { preset, dwarfId, mineId }
    : { preset, dwarfId, mineId, swap: mineId !== frontMine }
}

const taken = (id: string, queue: NeedsYouQueue, jump: JumpTarget | null = null): NeedsYouStep => ({
  ok: true,
  id,
  queue,
  jump
})

/** The queue without `dwarfId`'s entry, the others untouched (S34.03). */
const without = (queue: NeedsYouQueue, dwarfId: DwarfId): NeedsYouQueue =>
  queue.filter((entry) => entry.dwarfId !== dwarfId)

/**
 * S34.04: the dwarf's next ask is current, so its one entry takes the place the Host's order gives its `askedAt`: after
 * every entry asked at or before it. The other entries keep their order.
 */
function advanced(queue: NeedsYouQueue, at: number, next: number): NeedsYouQueue {
  const moved = { ...queue[at]!, askedAt: next }
  const rest = queue.filter((_, index) => index !== at)
  const place = rest.findIndex((entry) => entry.askedAt > next)
  return place === -1 ? [...rest, moved] : [...rest.slice(0, place), moved, ...rest.slice(place)]
}

/** One transition of the table of 07 machine 34, or `not-listed` (ADR-024). S34.12, the hold, is the read model's. */
export function stepNeedsYou(queue: NeedsYouQueue, input: NeedsYouInput): NeedsYouStep {
  switch (input.kind) {
    case 'snapshot':
      return taken('S34.01', input.queue)
    case 'ask-opened': {
      if (!isOpen(input.state)) return REFUSED
      // One entry per dwarf: a waiting dwarf's next ask queues behind its current one (ADR-010 item 7).
      if (queue.some((entry) => entry.dwarfId === input.dwarfId)) return taken('S34.02', queue)
      const added = { dwarfId: input.dwarfId, mineId: input.mineId, askedAt: input.askedAt }
      return taken('S34.02', [...queue, added])
    }
    case 'ask-closed': {
      const at = queue.findIndex((entry) => entry.dwarfId === input.dwarfId)
      if (at === -1) return REFUSED
      if (input.next === null) return taken('S34.03', without(queue, input.dwarfId))
      return taken('S34.04', advanced(queue, at, input.next))
    }
    case 'departed':
      if (!queue.some((entry) => entry.dwarfId === input.dwarfId)) return REFUSED
      return taken('S34.03', without(queue, input.dwarfId))
    case 'counter': {
      const oldest = queue[0]
      if (oldest === undefined) return taken('S34.08', queue)
      return taken(
        input.preset === 'control' ? 'S34.05' : 'S34.06',
        queue,
        jumpOf(oldest.dwarfId, oldest.mineId, input.preset, input.frontMine)
      )
    }
    case 'entry': {
      const jump = jumpOf(input.dwarfId, input.mineId, input.preset, input.frontMine)
      if (queue.some((entry) => entry.dwarfId === input.dwarfId))
        return taken('S34.07', queue, jump)
      return taken('S34.11', queue, input.present ? jump : null)
    }
    case 'preset-switch':
      return queue.length === 0 ? REFUSED : taken('S34.09', queue)
  }
}
