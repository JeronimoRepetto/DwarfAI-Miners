/*
 * The Work front's split (07 machine 30 `SplitState`; US-VALLE-008; UC-056; ADR-024 items 1, 4; ISSUE-303): "⫽" shows
 * two pinned chats side by side, never more. The mine wins its minimum, so below 640 px of room beside it the split
 * steps back to the focused pane (`suspended`, the wish kept) and comes back by itself when the room returns. Pure: the
 * caller hands each input with the facts machine 30 reads (the pins in tab order, the focused pin, the room) and
 * carries out the effects.
 *
 * - The panes are positional (`DS` organisms/chat-deck `panes[0..1]`, `pane`): the focused pane holds the pin set's
 *   focused chat (machine 29), the other pane the chat beside it. A click in the other pane, or on its tab, moves focus
 *   there and leaves both chats in place (S30.09); a tab not shown replaces the focused pane (S30.08).
 * - The wish is the Work front layout's `split` (A-N21, `14` §3.9 `ValleLayoutFront.split`), written on S30.01, S30.02,
 *   S30.10 to `off` and S30.11; `suspended` is derived and never written. The second pane's chat is the session's
 *   (A-N18 `valle.secondPaneDwarfId`, never persisted); an Add panel there is `null`, the session naming dwarfs only.
 * - "The next tab" is the first pin after the focused one in tab order, wrapping, that is not already shown.
 * - Only the transitions 07 machine 30 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import type { DwarfId } from '@dwarfai/contracts'
import type { PinKey } from './pins'
import { VALLE_LIST_FOLDED_WIDTH, VALLE_LIST_WIDTH } from './preset'
import { restoreSplit, VALLE_SPLIT_ROOM } from './restore'

export type SplitState = 'off' | 'on' | 'suspended'

export interface SplitSet {
  readonly state: SplitState
  /**
   * `on` and `suspended`: the two panes' chats, first then second (remembered while `suspended`); `off`: none. Never
   * more than two (machine 30 invariant `on`; US-VALLE-008.AC08).
   */
  readonly panes: readonly PinKey[]
  /** The pane holding focus: 0 the first, 1 the second (S30.09). */
  readonly pane: 0 | 1
}

/** `off`. */
export const SPLIT_OFF: SplitSet = { state: 'off', panes: [], pane: 0 }

/** A pin as machine 30 reads it: its key, its dwarf (`null` for an Add panel), whether it needs the person. */
export interface SplitPin {
  readonly key: PinKey
  readonly dwarfId: DwarfId | null
  readonly needs: boolean
}

/** What machine 30's guards read: the pins in tab order (every pin counts, 07 §22.4 V-11), the focus, the room. */
export interface SplitFacts {
  readonly pins: readonly SplitPin[]
  /** The pin set's focused pin (machine 29), after the input that moved it. */
  readonly focus: PinKey | null
  /** The room beside the mine at its Work front minimum (`splitRoom`). */
  readonly room: number
}

export type SplitInput =
  /** "⫽" pressed (S30.01…S30.04). */
  | { readonly kind: 'press' }
  /** The room changed: a window, work-area or display resize, or the list folding or unfolding (S30.05, S30.06). */
  | { readonly kind: 'resize' }
  /** The pin set's focus moved to `facts.focus`, its pins unchanged: a tab, a pane, a click (S30.08, S30.09). */
  | { readonly kind: 'focused' }
  /** A dive, a Work front swap or a list pick moved the selection; `before` is what the first pane showed (S30.07). */
  | { readonly kind: 'follow'; readonly before: PinKey | null }
  /** A shown pin was unpinned, closed or dropped (S30.10). */
  | { readonly kind: 'pins' }
  /** "Reset preset" in the Work front (S30.11, S37.04). */
  | { readonly kind: 'reset-preset' }
  /** Reset metrics (`ui.resetPreferences`, S30.12). */
  | { readonly kind: 'reset' }

export type SplitEffect =
  /** A-N21 `setUiPreference(valleLayout)` with the Work front's `split` set to the wish. */
  | { readonly kind: 'write-wish'; readonly split: boolean }
  /** A-N18 `patchUiSession({ kind: 'valle' })`: the second pane's chat. */
  | { readonly kind: 'session'; readonly patch: { secondPaneDwarfId: DwarfId | null } }

export type SplitStep =
  | {
      readonly ok: true
      /** The 07 machine 30 transition taken. */
      readonly id: string
      readonly set: SplitSet
      readonly effects: readonly SplitEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** What "⫽" shows (`DS/docs/copy.md`, Chat deck): enabled or not, pressed (the wish), and its title. */
export interface SplitButton {
  readonly disabled: boolean
  readonly pressed: boolean
  readonly title: string
}

const TWO_CHATS = 'Split · two chats side by side'
const WIDER = 'Split · needs a wider window'

const REFUSED: SplitStep = { ok: false, reason: 'not-listed' }

const pinned = (facts: SplitFacts, key: PinKey | null): boolean =>
  key !== null && facts.pins.some((pin) => pin.key === key)

const dwarfOf = (facts: SplitFacts, key: PinKey | undefined): DwarfId | null =>
  facts.pins.find((pin) => pin.key === key)?.dwarfId ?? null

/** The first pin after `from` in tab order, wrapping, that is not `from` itself. */
function nextTab(facts: SplitFacts, from: PinKey): PinKey | null {
  const at = facts.pins.findIndex((pin) => pin.key === from)
  for (let i = 1; i < facts.pins.length; i += 1) {
    const pin = facts.pins[(at + i) % facts.pins.length]!
    if (pin.key !== from) return pin.key
  }
  return null
}

/** S30.01: the first other pin in tab order that needs the person, else the first other pin. */
function pairFor(facts: SplitFacts, focus: PinKey): PinKey | null {
  const others = facts.pins.filter((pin) => pin.key !== focus)
  return (others.find((pin) => pin.needs) ?? others[0])?.key ?? null
}

/** `kept` when it is pinned and not the focused chat, else the next tab after the focused one. */
const keptOrNext = (facts: SplitFacts, focus: PinKey, kept: PinKey | null): PinKey | null =>
  kept !== null && kept !== focus && pinned(facts, kept) ? kept : nextTab(facts, focus)

/** The panes with `focus` in pane `pane` and `other` in the other one. */
const placed = (focus: PinKey, other: PinKey, pane: 0 | 1): readonly PinKey[] =>
  pane === 0 ? [focus, other] : [other, focus]

/** The session patch when the second pane's chat changed from `before` to `after`. */
function sessionOf(facts: SplitFacts, before: SplitSet, after: SplitSet): SplitEffect[] {
  const was = before.panes[1]
  const now = after.panes[1]
  if (was === now) return []
  return [{ kind: 'session', patch: { secondPaneDwarfId: dwarfOf(facts, now) } }]
}

function taken(
  id: string,
  facts: SplitFacts,
  before: SplitSet,
  after: SplitSet,
  wish?: boolean
): SplitStep {
  const effects: SplitEffect[] = wish === undefined ? [] : [{ kind: 'write-wish', split: wish }]
  return { ok: true, id, set: after, effects: [...effects, ...sessionOf(facts, before, after)] }
}

/** The split on, `focus` in pane `pane`, `other` beside it. */
const onWith = (focus: PinKey, other: PinKey, pane: 0 | 1): SplitSet => ({
  state: 'on',
  panes: placed(focus, other, pane),
  pane
})

export function stepSplit(set: SplitSet, input: SplitInput, facts: SplitFacts): SplitStep {
  // Any state but `off`: Reset preset writes the wish off (S30.11); Reset metrics returns to the default (S30.12).
  if (input.kind === 'reset') return taken('S30.12', facts, SPLIT_OFF, SPLIT_OFF)
  if (input.kind === 'reset-preset') {
    return set.state === 'off' ? REFUSED : taken('S30.11', facts, set, SPLIT_OFF, false)
  }

  const focus = facts.focus
  switch (set.state) {
    case 'off': {
      if (input.kind !== 'press') return REFUSED
      if (facts.pins.length < 2 || focus === null) return taken('S30.03', facts, set, set)
      if (facts.room < VALLE_SPLIT_ROOM) return taken('S30.04', facts, set, set)
      const other = pairFor(facts, focus)
      return other === null ? REFUSED : taken('S30.01', facts, set, onWith(focus, other, 0), true)
    }
    case 'suspended': {
      if (input.kind !== 'resize' || facts.room < VALLE_SPLIT_ROOM || focus === null) return REFUSED
      if (facts.pins.length < 2) return REFUSED
      const remembered = set.panes[set.pane === 0 ? 1 : 0] ?? null
      const other = keptOrNext(facts, focus, remembered)
      return other === null ? REFUSED : taken('S30.06', facts, set, onWith(focus, other, set.pane))
    }
    case 'on':
      return stepOn(set, input, facts)
  }
}

/** The transitions out of `on`. */
function stepOn(set: SplitSet, input: SplitInput, facts: SplitFacts): SplitStep {
  const focus = facts.focus
  const shown = set.panes[set.pane]!
  const other = set.panes[set.pane === 0 ? 1 : 0]!
  switch (input.kind) {
    case 'press':
      return taken('S30.02', facts, set, SPLIT_OFF, false)
    case 'resize':
      if (facts.room >= VALLE_SPLIT_ROOM) return REFUSED
      return taken('S30.05', facts, set, { ...set, state: 'suspended' })
    case 'focused': {
      if (focus === null || focus === shown) return REFUSED
      if (focus === other) {
        const pane = set.pane === 0 ? 1 : 0
        return taken('S30.09', facts, set, { ...set, pane })
      }
      return taken('S30.08', facts, set, onWith(focus, other, set.pane))
    }
    case 'follow': {
      if (focus === null) return REFUSED
      const second = keptOrNext(facts, focus, input.before)
      return second === null ? REFUSED : taken('S30.07', facts, set, onWith(focus, second, 0))
    }
    case 'pins': {
      const lost = !pinned(facts, shown) || !pinned(facts, other) || focus !== shown
      if (!lost) return REFUSED
      if (facts.pins.length < 2 || focus === null) {
        return taken('S30.10', facts, set, SPLIT_OFF, false)
      }
      const second = keptOrNext(facts, focus, other)
      return second === null
        ? taken('S30.10', facts, set, SPLIT_OFF, false)
        : taken('S30.10', facts, set, onWith(focus, second, set.pane))
    }
    default:
      return REFUSED
  }
}

/** The panes shown, first then second: two while `on`, else the focused chat alone (none with no pin). */
export function splitPanes(set: SplitSet, focus: PinKey | null): readonly PinKey[] {
  if (set.state === 'on') return set.panes
  return focus === null ? [] : [focus]
}

/**
 * "⫽" (`DS/docs/copy.md`; S30.03, S30.04, `suspended`): disabled with fewer than two pins, titled "Split · two chats
 * side by side" (US-VALLE-008.AC06, which wins the title when the room is short too); disabled while the room is short,
 * titled "Split · needs a wider window"; pressed while the wish is on.
 */
export function splitButton(set: SplitSet, facts: SplitFacts): SplitButton {
  const pressed = set.state !== 'off'
  if (facts.pins.length < 2) return { disabled: true, pressed, title: TWO_CHATS }
  if (set.state === 'suspended' || facts.room < VALLE_SPLIT_ROOM) {
    return { disabled: true, pressed, title: WIDER }
  }
  return { disabled: false, pressed, title: TWO_CHATS }
}

/**
 * S30.13: the persisted wish re-evaluated when Valle opens (`restoreSplit`, ISSUE-300), the focused chat in the first
 * pane and beside it the session's second pane while it is still pinned, else S30.01's pick.
 */
export function restoredSplit(
  wish: boolean,
  remembered: PinKey | null,
  facts: SplitFacts
): SplitSet {
  const state = restoreSplit(wish, { pins: facts.pins.length, room: facts.room })
  const focus = facts.focus
  if (state === 'off' || focus === null) return SPLIT_OFF
  const other =
    remembered !== null && remembered !== focus && pinned(facts, remembered)
      ? remembered
      : pairFor(facts, focus)
  return other === null ? SPLIT_OFF : { state, panes: [focus, other], pane: 0 }
}

/** Valle's nav column, the splitter, and the gaps of the body's grid (`DS/docs/screens/valle.md` Layout). */
const NAV = 56
const SPLITTER = 12
const BODY_GAPS = 3 * 6
/** What the body's grid always takes besides its main zone and its chat zone: the nav, the splitter, the three gaps. */
export const VALLE_BODY_FIXED = NAV + SPLITTER + BODY_GAPS
/** The gap between the Work front's list and its mine. */
const LIST_GAP = 6

/** The mine's Work front minimum: `max(300, 16 + 48 × portraits (≤ 5) + 112)` (07 machine 30). */
export function mineMinimum(portraits: number): number {
  return Math.max(300, 16 + 48 * Math.min(Math.max(portraits, 0), 5) + 112)
}

/**
 * 07 machine 30's room: the body's width − nav 56 − splitter 12 − 3 × 6 px gaps − the list (232, or 44 folded) − 6 px −
 * the mine's Work front minimum. The split needs 640 px of it.
 */
export function splitRoom(layout: {
  body: number
  foldedList: boolean
  portraits: number
}): number {
  const list = layout.foldedList ? VALLE_LIST_FOLDED_WIDTH : VALLE_LIST_WIDTH
  return layout.body - VALLE_BODY_FIXED - list - LIST_GAP - mineMinimum(layout.portraits)
}
