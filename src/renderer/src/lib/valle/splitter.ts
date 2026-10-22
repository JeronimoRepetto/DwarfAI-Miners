/*
 * The splitter between Valle's mines and its chats (07 machine 33 `SplitterState`; US-VALLE-005; UC-057; ADR-024
 * items 1, 4; NFR-PERF-01; ISSUE-305): the 12 px bar that sets the chat zone's width per preset. Pure: the caller hands
 * each input with the facts machine 33 reads (the preset shown, its stored width, the body's geometry) and carries out
 * the effects.
 *
 * - A drag follows the pointer with no easing, clamped to the range (S33.01); the release saves the width for the
 *   preset shown (S33.02, A-N21 `valleLayout[preset].chatWidth`), a pointercancel returns to the width at the press
 *   (S33.03). The chat zone sits after the bar, so dragging left widens it (`DS` molecules/splitter, `dir: -1`).
 * - ← / → move it 16 px, Home / End jump to the minimum / maximum, each committed at once (S33.04, S33.05).
 * - Enter or a double click resets the preset shown alone to its default: the stored value cleared
 *   (`VALLE_CHAT_WIDTH_UNSET`), the zones' content FLIPping while the width itself jumps (S33.06, S33.07).
 * - At rest the effective width is the stored width clamped to the current range, or the preset's default when nothing
 *   is stored: a resize, a fold, a split or a roster change only moves the range, and the stored width is kept until
 *   the person commits again (S33.08; 07 §24 I-32).
 * - The ranges (`DS/docs/screens/valle.md` Layout): the Control room from 340 px to what leaves 248 px for the mines,
 *   440 px by default; the Work front from 340 px (640 px, machine 30's room, with two chats side by side) to what leaves
 *   the mine its Work front minimum (machine 30's `splitRoom`), by default what leaves the mine max(its minimum, 400 px).
 * - A body narrower than both minimums: the mine's minimum wins and the chat zone takes what is left beside it (S33.12);
 *   how it gives way below 340 px is the design's to say (07 §24 I-32).
 * - Only the transitions 07 machine 33 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import {
  VALLE_CHAT_WIDTH_UNSET,
  VALLE_CONTROL_CHAT_WIDTH,
  type ValleLayouts,
  type VallePreset
} from './preset'
import { VALLE_SPLIT_ROOM } from './restore'
import { mineMinimum, splitRoom, VALLE_BODY_FIXED } from './split'

export type SplitterState = 'rest' | 'dragging' | 'resetting'

export interface SplitterSet {
  readonly state: SplitterState
  /** `dragging`: the width the pointer gives now, clamped; otherwise `null`, the effective width showing. */
  readonly live: number | null
  /** `dragging`: where the press was, the width then, and the preset the drag saves for. */
  readonly press: {
    readonly x: number
    readonly width: number
    readonly preset: VallePreset
  } | null
}

export const SPLITTER_REST: SplitterSet = { state: 'rest', live: null, press: null }

/** What the ranges are computed from: the body's content width (`null` before it is measured) and the Work front. */
export interface SplitterGeometry {
  readonly body: number | null
  /** The Work front's compact list is folded (44 px instead of 232). */
  readonly foldedList: boolean
  /** The portraits of the Work front's mine. */
  readonly portraits: number
  /** Two chats are side by side (machine 30 `on`). */
  readonly split: boolean
}

export interface SplitterRange {
  readonly min: number
  readonly max: number
}

/** What machine 33 reads: the preset shown, the width stored for it, the geometry. */
export interface SplitterFacts {
  readonly preset: VallePreset
  /** `valleLayout[preset].chatWidth`; `VALLE_CHAT_WIDTH_UNSET` when the person never set it. */
  readonly stored: number
  readonly geometry: SplitterGeometry
}

export type SplitterKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter'

export type SplitterInput =
  /** The primary button pressed on the splitter, at `x` (S33.01). */
  | { readonly kind: 'press'; readonly x: number }
  /** The pointer moved while pressed (S33.01). */
  | { readonly kind: 'move'; readonly x: number }
  /** Released (S33.02). */
  | { readonly kind: 'release' }
  /** A pointercancel (S33.03). */
  | { readonly kind: 'cancel' }
  /** A key on the focused splitter (S33.04, S33.05, S33.06). */
  | { readonly kind: 'key'; readonly key: SplitterKey }
  /** A double click (S33.06). */
  | { readonly kind: 'double-click' }
  /** The reset's FLIP done, its watchdog, or reduced motion in the same frame (S33.07). */
  | { readonly kind: 'settled' }
  /** The range moved: a resize, the list folding or unfolding, a split on or off, a roster change (S33.08). */
  | { readonly kind: 'reflow' }
  /** A preset switch (S33.09). */
  | { readonly kind: 'preset' }
  /** "Reset preset" or Reset metrics (S33.10): the default width, its stored value cleared by its owner. */
  | { readonly kind: 'reset' }

export type SplitterEffect =
  /** The zones' content FLIPs from the old layout to the new one; the width never animates (S33.06). */
  | { readonly kind: 'flip' }
  /** A-N21 `setUiPreference(valleLayout)` with `preset`'s `chatWidth` set. */
  | { readonly kind: 'commit'; readonly preset: VallePreset; readonly chatWidth: number }

export type SplitterStep =
  | {
      readonly ok: true
      /** The 07 machine 33 transition taken. */
      readonly id: string
      readonly set: SplitterSet
      readonly effects: readonly SplitterEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** The chat zone's minimum (`DS` `CHAT_MIN`). With two chats side by side it is machine 30's room, 640 px. */
export const VALLE_CHAT_MIN = 340
/** What the Control room keeps for the mines (`DS` `COLUMN_KEEP`). */
export const VALLE_MINES_KEEP = 248
/** The least the Work front's mine keeps by default (`DS` "Work front: the least the mine keeps by default"). */
export const VALLE_FRONT_ROOM = 400
/** One ← / → press (`DS` molecules/splitter `step`). */
export const VALLE_SPLITTER_STEP = 16
/** The maximum before the body is measured (`DS` "Splitter maximum before the layout is measured"). */
export const VALLE_SPLITTER_UNMEASURED_MAX = 900

const REFUSED: SplitterStep = { ok: false, reason: 'not-listed' }

/**
 * The preset's range now. When the body cannot hold both minimums the mine's wins (S33.12): the maximum is what is left
 * beside it (never below 0) and the chat zone's own minimum gives way to it.
 */
export function splitterRange(preset: VallePreset, geometry: SplitterGeometry): SplitterRange {
  const floor = preset === 'front' && geometry.split ? VALLE_SPLIT_ROOM : VALLE_CHAT_MIN
  if (geometry.body === null) return { min: floor, max: VALLE_SPLITTER_UNMEASURED_MAX }
  const room =
    preset === 'control'
      ? geometry.body - VALLE_BODY_FIXED - VALLE_MINES_KEEP
      : splitRoom({
          body: geometry.body,
          foldedList: geometry.foldedList,
          portraits: geometry.portraits
        })
  const max = Math.max(0, Math.round(room))
  return { min: Math.min(floor, max), max }
}

/** The preset's default width: 440 px in the Control room; the Work front leaves the mine max(its minimum, 400 px). */
export function splitterDefault(preset: VallePreset, geometry: SplitterGeometry): number {
  if (preset === 'control' || geometry.body === null) return VALLE_CONTROL_CHAT_WIDTH
  const mine = mineMinimum(geometry.portraits)
  const room = splitRoom({
    body: geometry.body,
    foldedList: geometry.foldedList,
    portraits: geometry.portraits
  })
  return room + mine - Math.max(mine, VALLE_FRONT_ROOM)
}

const clamp = (width: number, range: SplitterRange): number =>
  Math.round(Math.min(range.max, Math.max(range.min, width)))

/** `rest`: the stored width clamped to the current range, the default when nothing is stored. */
export function effectiveWidth(facts: SplitterFacts): number {
  const wanted =
    facts.stored === VALLE_CHAT_WIDTH_UNSET
      ? splitterDefault(facts.preset, facts.geometry)
      : facts.stored
  return clamp(wanted, splitterRange(facts.preset, facts.geometry))
}

/** The width the chat zone shows: the live width while dragging, else the effective width. */
export function shownWidth(set: SplitterSet, facts: SplitterFacts): number {
  return set.live ?? effectiveWidth(facts)
}

/** Both layouts with `preset`'s chat width set; the other preset's layout is the same object, untouched (S33.09). */
export function withChatWidth(
  layouts: ValleLayouts,
  preset: VallePreset,
  chatWidth: number
): ValleLayouts {
  return preset === 'control'
    ? { ...layouts, control: { ...layouts.control, chatWidth } }
    : { ...layouts, front: { ...layouts.front, chatWidth } }
}

function taken(
  id: string,
  set: SplitterSet,
  effects: readonly SplitterEffect[] = []
): SplitterStep {
  return { ok: true, id, set, effects }
}

const commit = (facts: SplitterFacts, chatWidth: number): SplitterEffect => ({
  kind: 'commit',
  preset: facts.preset,
  chatWidth
})

/** S33.06: the preset's own default, its stored value cleared, the content FLIPping. */
const reset = (facts: SplitterFacts): SplitterStep =>
  taken('S33.06', { state: 'resetting', live: null, press: null }, [
    { kind: 'flip' },
    commit(facts, VALLE_CHAT_WIDTH_UNSET)
  ])

/** S33.04, S33.05, S33.06: a key on the focused splitter at rest. */
function keyed(key: SplitterKey, facts: SplitterFacts): SplitterStep {
  if (key === 'Enter') return reset(facts)
  const range = splitterRange(facts.preset, facts.geometry)
  if (key === 'Home') return taken('S33.05', SPLITTER_REST, [commit(facts, range.min)])
  if (key === 'End') return taken('S33.05', SPLITTER_REST, [commit(facts, range.max)])
  // The chat zone sits after the bar: ← moves the bar left and widens it.
  const step = key === 'ArrowLeft' ? VALLE_SPLITTER_STEP : -VALLE_SPLITTER_STEP
  return taken('S33.04', SPLITTER_REST, [commit(facts, clamp(effectiveWidth(facts) + step, range))])
}

export function stepSplitter(
  set: SplitterSet,
  input: SplitterInput,
  facts: SplitterFacts
): SplitterStep {
  // Any state: "Reset preset" or Reset metrics give the default width (S33.10).
  if (input.kind === 'reset') return taken('S33.10', SPLITTER_REST)

  switch (set.state) {
    case 'rest':
      switch (input.kind) {
        case 'press': {
          const width = effectiveWidth(facts)
          return taken('S33.01', {
            state: 'dragging',
            live: width,
            press: { x: input.x, width, preset: facts.preset }
          })
        }
        case 'key':
          return keyed(input.key, facts)
        case 'double-click':
          return reset(facts)
        case 'reflow':
          return taken('S33.08', SPLITTER_REST)
        case 'preset':
          return taken('S33.09', SPLITTER_REST)
        default:
          return REFUSED
      }
    case 'dragging': {
      const press = set.press!
      switch (input.kind) {
        case 'move': {
          const range = splitterRange(facts.preset, facts.geometry)
          const live = clamp(press.width - (input.x - press.x), range)
          return taken('S33.01', { ...set, live })
        }
        case 'release':
          return taken('S33.02', SPLITTER_REST, [
            { kind: 'commit', preset: press.preset, chatWidth: set.live ?? press.width }
          ])
        case 'cancel':
          return taken('S33.03', SPLITTER_REST)
        default:
          return REFUSED
      }
    }
    case 'resetting':
      return input.kind === 'settled' ? taken('S33.07', SPLITTER_REST) : REFUSED
  }
}
