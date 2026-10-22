/*
 * Valle's pinned chats (07 machine 29 `PinSetState`; US-VALLE-007; ADR-024 items 1, 4; INV-117; ISSUE-302): every open
 * chat in Valle is a pin, a line of the Control room's stack or a tab of the Work front; this is the set, its order and
 * its focus. Each pin's own life (`live` ⇄ `gone`) is machine 18 (`pinnedChat.ts`). Pure: the caller hands each input
 * and carries out the effects.
 *
 * - Clicking a dwarf anywhere in Valle pins its chat last and focuses it; clicking a pinned one only moves focus
 *   (S29.03…S29.05). Focus is the Control room's expanded line and the Work front's selected tab.
 * - ×, a middle click or Delete/Backspace unpin (S29.10, S29.11); the session keeps running, untouched. Keyboard focus
 *   moves to what took the pin's place: the next, else the one before, else the deck or stack itself, never dropped.
 * - Work front tabs reorder by drag, committed on drop, kept on a cancel (S29.07…S29.09).
 * - A dwarf's departure leaves its pin `gone` and read-only (S29.13); its mine's removal closes its pins (S29.14).
 * - An Add panel opened in Valle is a pin of kind `add` (S29.16), session-only: it becomes the new dwarf's chat when the
 *   launch lands (S29.17), or goes on × with nothing launched (S29.18).
 * - Every change of the chat pins is written whole (`write-pins`, A-N21; chat pins only, R5B-27), so a failed write is
 *   made good by the next (S29.21); the focus and the Add pins are the session's (A-N18), never persisted (S29.22).
 * - The first open with no stored set pins the waiting dwarfs, oldest question first, then the chat talked to last
 *   (S29.01); a stored set is restored (S29.02, `restore.ts`).
 * - The dive's tab order (S29.12) is injected as a function, never imported (later: ISSUE-301).
 * - Only the transitions 07 machine 29 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import type { DwarfId, DwarfStatus, MineId, UiSessionSnapshot } from '@dwarfai/contracts'
import { isChatReadOnly, stepPinnedChat, type PinnedChatState } from './pinnedChat'
import type { RestoredPin, StoredPin } from './restore'

/** A pin's key: a chat's is its dwarf's id, an Add pin's its mine's id behind `add:` (one Add panel per mine). */
export type PinKey = string

export interface ChatPin {
  readonly kind: 'chat'
  readonly key: PinKey
  readonly dwarfId: DwarfId
  readonly mineId: MineId
  readonly state: PinnedChatState
}

/** The Add panel, pinned while it is open (S29.16). */
export interface AddPin {
  readonly kind: 'add'
  readonly key: PinKey
  readonly mineId: MineId
}

export type Pin = ChatPin | AddPin

export interface PinSet {
  /** In order: the stack's lines top down, the strip's tabs left to right. */
  readonly pins: readonly Pin[]
  /** The pin in focus (Control room: expanded; Work front: selected); `null` with no pin. */
  readonly focus: PinKey | null
  /** The tab being dragged (`reordering`), else `null`. */
  readonly dragging: PinKey | null
  /** 07 N-16: the last chat focused per mine since Valle opened. */
  readonly talkedTo: Readonly<Record<MineId, DwarfId>>
}

/** `empty`. */
export const NO_PINS: PinSet = { pins: [], focus: null, dragging: null, talkedTo: {} }

export const addKey = (mineId: MineId): PinKey => `add:${mineId}`

/** A pin as the dive's order reads and returns it. */
export type PinRef =
  | { readonly kind: 'chat'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  | { readonly kind: 'add'; readonly mineId: MineId }

export interface DiveOrderInput {
  readonly pins: readonly PinRef[]
  readonly mineId: MineId
  readonly forDwarfId: DwarfId | null
}

/** S29.12's tab order, injected by the dive (later: ISSUE-301): the whole new order, the mine's dwarfs pinned. */
export type DiveOrder = (input: DiveOrderInput) => readonly PinRef[]

export type PinInput =
  /** A dwarf clicked anywhere in Valle: a sprite, a roster portrait (S29.03…S29.05). */
  | { readonly kind: 'click'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  /** A stack line or a tab clicked, or Enter/Space on a focused tab (S29.05). */
  | { readonly kind: 'select'; readonly key: PinKey }
  /** A Work front tab picked up (S29.07). */
  | { readonly kind: 'drag'; readonly key: PinKey }
  /** Dropped, the strip in its new order (S29.08). */
  | { readonly kind: 'drop'; readonly order: readonly PinKey[] }
  /** pointercancel or Esc during a drag (S29.09). */
  | { readonly kind: 'drag-cancel' }
  /** ×, a middle click, Delete/Backspace (S29.10, S29.11, S29.18). */
  | { readonly kind: 'unpin'; readonly key: PinKey }
  /** A dive or a Work front swap (S29.12). */
  | {
      readonly kind: 'dive'
      readonly mineId: MineId
      readonly forDwarfId: DwarfId | null
      readonly order: DiveOrder
    }
  /** `DwarfDeparted` of a pinned dwarf; `mineRemoved` for the cause `mine-removed` (S29.13, S29.14). */
  | { readonly kind: 'departed'; readonly dwarfId: DwarfId; readonly mineRemoved: boolean }
  /** `MineRemoved` (S29.14). */
  | { readonly kind: 'mine-removed'; readonly mineId: MineId }
  /** The Add panel opened in Valle: a roster "+", "+ Dwarf" (S29.16). */
  | { readonly kind: 'add-open'; readonly mineId: MineId }
  /** `DwarfLaunched` of the launch sent from that mine's Add pin (S29.17). */
  | { readonly kind: 'launched'; readonly mineId: MineId; readonly dwarfId: DwarfId }
  /** A needs-you jump or entry, a reveal (S29.19). */
  | { readonly kind: 'jump'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  /** `ui.resetPreferences`, Reset metrics (S29.20). */
  | { readonly kind: 'reset' }
  /** S27.05 into Valle with a carried chat; `present`: the carried dwarf is present (S29.23). */
  | {
      readonly kind: 'carried'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly present: boolean
    }

export type PinEffect =
  /** A-N21 `setUiPreference(pins)`: the chat pins in order, whole. */
  | { readonly kind: 'write-pins'; readonly pins: StoredPin[] }
  /** A-N18 `patchUiSession({ kind: 'valle' })`. */
  | { readonly kind: 'session'; readonly patch: UiSessionSnapshot['valle'] }
  /** A-N18 `patchUiSession({ kind: 'open-chat', host: 'valle' })`. */
  | { readonly kind: 'open-chat'; readonly dwarfId: DwarfId | null }
  /** A-N18 `patchUiSession({ kind: 'current-mine', host: 'valle' })` (S35.01). */
  | { readonly kind: 'current-mine'; readonly mineId: MineId }
  /** Where keyboard focus goes: a pin, or the deck or stack itself. */
  | { readonly kind: 'keyboard-focus'; readonly target: PinKey | 'container' }

export type PinStep =
  | {
      readonly ok: true
      /** The 07 machine 29 transition taken. */
      readonly id: string
      readonly set: PinSet
      readonly effects: readonly PinEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

const REFUSED: PinStep = { ok: false, reason: 'not-listed' }

const chatPin = (dwarfId: DwarfId, mineId: MineId, state: PinnedChatState = 'live'): ChatPin => ({
  kind: 'chat',
  key: dwarfId,
  dwarfId,
  mineId,
  state
})
const addPin = (mineId: MineId): AddPin => ({ kind: 'add', key: addKey(mineId), mineId })

/** What `pins` stores: the chat pins, each with its place in the whole order; never an Add pin (R5B-27). */
function storedOf(pins: readonly Pin[]): StoredPin[] {
  const stored: StoredPin[] = []
  pins.forEach((pin, order) => {
    if (pin.kind === 'chat') stored.push({ dwarfId: pin.dwarfId, mineId: pin.mineId, order })
  })
  return stored
}

/** What the session's `valle.addPins` holds: the Add pins, each with its place in the whole order. */
function addPinsOf(pins: readonly Pin[]): NonNullable<UiSessionSnapshot['valle']['addPins']> {
  const adds: { mineId: MineId; order: number }[] = []
  pins.forEach((pin, order) => {
    if (pin.kind === 'add') adds.push({ mineId: pin.mineId, order })
  })
  return adds
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const pinOf = (set: PinSet, key: PinKey | null): Pin | undefined =>
  key === null ? undefined : set.pins.find((pin) => pin.key === key)

/** Focus on `key`; a chat focused counts as talked to in its mine (07 N-16). */
function focusOn(set: PinSet, key: PinKey | null): PinSet {
  const pin = pinOf(set, key)
  if (pin === undefined) return { ...set, focus: null }
  const talkedTo =
    pin.kind === 'chat' ? { ...set.talkedTo, [pin.mineId]: pin.dwarfId } : set.talkedTo
  return { ...set, focus: pin.key, talkedTo }
}

/** The effects of going from `before` to `after`, `extra` after them. */
function effectsOf(before: PinSet, after: PinSet, extra: readonly PinEffect[] = []): PinEffect[] {
  const effects: PinEffect[] = []
  const stored = storedOf(after.pins)
  if (!same(storedOf(before.pins), stored)) effects.push({ kind: 'write-pins', pins: stored })

  const patch: UiSessionSnapshot['valle'] = {}
  const adds = addPinsOf(after.pins)
  if (!same(addPinsOf(before.pins), adds)) patch.addPins = adds
  const focused = pinOf(after, after.focus)
  const focusMoved = before.focus !== after.focus
  if (focusMoved) patch.focusedPin = focused?.kind === 'chat' ? focused.dwarfId : null
  if (!same(before.talkedTo, after.talkedTo)) patch.talkedTo = { ...after.talkedTo }
  if (Object.keys(patch).length > 0) effects.push({ kind: 'session', patch })

  if (focusMoved) {
    effects.push({ kind: 'open-chat', dwarfId: focused?.kind === 'chat' ? focused.dwarfId : null })
    if (focused !== undefined) effects.push({ kind: 'current-mine', mineId: focused.mineId })
  }
  return [...effects, ...extra]
}

function taken(id: string, before: PinSet, after: PinSet, extra?: readonly PinEffect[]): PinStep {
  return { ok: true, id, set: after, effects: effectsOf(before, after, extra) }
}

/** The pin for `dwarfId` pinned last when absent, then focused (S29.03, S29.04, S29.19, S29.23). */
function pinAndFocus(set: PinSet, dwarfId: DwarfId, mineId: MineId): PinSet {
  const pinned = set.pins.some((pin) => pin.key === dwarfId)
  const pins = pinned ? set.pins : [...set.pins, chatPin(dwarfId, mineId)]
  return focusOn({ ...set, pins }, dwarfId)
}

/**
 * The pins in `gone` removed. Focus, and keyboard focus, move to what took the first removed pin's place: the next,
 * else the one before it, else the deck or stack itself ("Unpin keeps focus").
 */
function removed(
  set: PinSet,
  gone: ReadonlySet<PinKey>
): { set: PinSet; target: PinKey | 'container' } {
  const at = set.pins.findIndex((pin) => gone.has(pin.key))
  const pins = set.pins.filter((pin) => !gone.has(pin.key))
  const kept = set.pins.slice(0, at).filter((pin) => !gone.has(pin.key)).length
  const neighbour = pins[kept] ?? pins[kept - 1]
  const target = neighbour?.key ?? 'container'
  const next = { ...set, pins }
  if (set.focus !== null && !gone.has(set.focus)) return { set: next, target }
  return { set: focusOn(next, neighbour?.key ?? null), target }
}

/** The order a drop commits, when it is a permutation of the strip's own pins. */
function reordered(set: PinSet, order: readonly PinKey[]): readonly Pin[] | null {
  if (order.length !== set.pins.length || new Set(order).size !== order.length) return null
  const pins: Pin[] = []
  for (const key of order) {
    const pin = pinOf(set, key)
    if (pin === undefined) return null
    pins.push(pin)
  }
  return pins
}

const refOf = (pin: Pin): PinRef =>
  pin.kind === 'chat'
    ? { kind: 'chat', dwarfId: pin.dwarfId, mineId: pin.mineId }
    : { kind: 'add', mineId: pin.mineId }

export function stepPins(set: PinSet, input: PinInput): PinStep {
  // Any state: Reset metrics clears every pin; UI main already returned the store to never written (S29.20, S18.06).
  if (input.kind === 'reset') return { ok: true, id: 'S29.20', set: NO_PINS, effects: [] }

  if (set.dragging !== null) {
    // `reordering`: only the drop or a cancel ends it.
    if (input.kind === 'drop') {
      const pins = reordered(set, input.order)
      return pins === null ? REFUSED : taken('S29.08', set, { ...set, pins, dragging: null })
    }
    if (input.kind === 'drag-cancel') return taken('S29.09', set, { ...set, dragging: null })
    return REFUSED
  }

  switch (input.kind) {
    case 'click': {
      const id = set.pins.length === 0 ? 'S29.03' : pinOf(set, input.dwarfId) ? 'S29.05' : 'S29.04'
      return taken(id, set, pinAndFocus(set, input.dwarfId, input.mineId))
    }
    case 'select':
      return pinOf(set, input.key) ? taken('S29.05', set, focusOn(set, input.key)) : REFUSED
    case 'drag':
      if (set.pins.length < 2 || !pinOf(set, input.key)) return REFUSED
      return taken('S29.07', set, { ...set, dragging: input.key })
    case 'unpin': {
      const pin = pinOf(set, input.key)
      if (pin === undefined) return REFUSED
      const after = removed(set, new Set([pin.key]))
      const id = pin.kind === 'add' ? 'S29.18' : after.set.pins.length === 0 ? 'S29.11' : 'S29.10'
      return taken(id, set, after.set, [{ kind: 'keyboard-focus', target: after.target }])
    }
    case 'dive': {
      const refs = input.order({
        pins: set.pins.map(refOf),
        mineId: input.mineId,
        forDwarfId: input.forDwarfId
      })
      const pins = refs.map((ref) => {
        const key = ref.kind === 'chat' ? ref.dwarfId : addKey(ref.mineId)
        return (
          pinOf(set, key) ??
          (ref.kind === 'chat' ? chatPin(ref.dwarfId, ref.mineId) : addPin(ref.mineId))
        )
      })
      return taken('S29.12', set, focusOn({ ...set, pins }, pins[0]?.key ?? null))
    }
    case 'departed': {
      const pin = pinOf(set, input.dwarfId)
      if (pin?.kind !== 'chat') return REFUSED
      if (input.mineRemoved) return taken('S29.14', set, removed(set, new Set([pin.key])).set)
      const step = stepPinnedChat(pin.state, { kind: 'departed', mineRemoved: false })
      if (!step.ok || step.state === 'closed') return REFUSED
      const gone: ChatPin = { ...pin, state: step.state }
      return taken('S29.13', set, {
        ...set,
        pins: set.pins.map((p) => (p.key === pin.key ? gone : p))
      })
    }
    case 'mine-removed': {
      const gone = new Set(
        set.pins.filter((pin) => pin.mineId === input.mineId).map((pin) => pin.key)
      )
      return gone.size === 0 ? REFUSED : taken('S29.14', set, removed(set, gone).set)
    }
    case 'add-open': {
      const key = addKey(input.mineId)
      const pins = pinOf(set, key) ? set.pins : [...set.pins, addPin(input.mineId)]
      return taken('S29.16', set, focusOn({ ...set, pins }, key))
    }
    case 'launched': {
      const key = addKey(input.mineId)
      if (!pinOf(set, key) || pinOf(set, input.dwarfId)) return REFUSED
      const chat = chatPin(input.dwarfId, input.mineId)
      const after = { ...set, pins: set.pins.map((pin) => (pin.key === key ? chat : pin)) }
      return taken('S29.17', set, set.focus === key ? focusOn(after, chat.key) : after)
    }
    case 'jump':
      return taken('S29.19', set, pinAndFocus(set, input.dwarfId, input.mineId))
    case 'carried':
      if (!input.present) return REFUSED
      return taken('S29.23', set, pinAndFocus(set, input.dwarfId, input.mineId), [
        { kind: 'session', patch: { diveForDwarfId: input.dwarfId } }
      ])
    default:
      return REFUSED
  }
}

/** What the first open with no stored pin set reads (S29.01; 07 §24 I-29). */
export interface StartUpFacts {
  /** Every waiting dwarf with the time its question was asked. */
  readonly needsYou: readonly { dwarfId: DwarfId; mineId: MineId; askedAt: number }[]
  /** The chat talked to last (07 N-16), if any. */
  readonly talkedLast: { dwarfId: DwarfId; mineId: MineId } | null
}

/**
 * S29.01: every waiting dwarf, oldest question first, then the chat talked to last; the first waiting dwarf in focus
 * (else the one talked to last). Those count as talked to, a later one winning its mine. An empty set writes nothing:
 * the store stays never written, so the next open is S29.01 again.
 */
export function startUpPins(facts: StartUpFacts): {
  id: 'S29.01'
  set: PinSet
  effects: readonly PinEffect[]
} {
  const waiting = [...facts.needsYou].sort((a, b) => a.askedAt - b.askedAt)
  const order = facts.talkedLast === null ? waiting : [...waiting, facts.talkedLast]
  const pins: ChatPin[] = []
  const talkedTo: Record<MineId, DwarfId> = {}
  for (const { dwarfId, mineId } of order) {
    if (!pins.some((pin) => pin.key === dwarfId)) pins.push(chatPin(dwarfId, mineId))
    talkedTo[mineId] = dwarfId
  }
  const set: PinSet = { pins, focus: pins[0]?.key ?? null, dragging: null, talkedTo }
  return { id: 'S29.01', set, effects: effectsOf(NO_PINS, set) }
}

/**
 * The set Valle opens on with a stored pin set (S29.02, restored by `restorePins`): the chat pins in order, the
 * session's Add pins back in their places, focus on the session's focused pin while it is pinned, else the first.
 */
export function restoredPins(
  restored: readonly RestoredPin[],
  session: UiSessionSnapshot['valle']
): PinSet {
  const pins: Pin[] = restored.map((pin) => chatPin(pin.dwarfId, pin.mineId, pin.state))
  for (const add of [...(session.addPins ?? [])].sort((a, b) => a.order - b.order)) {
    if (!pins.some((pin) => pin.key === addKey(add.mineId))) {
      pins.splice(Math.min(add.order, pins.length), 0, addPin(add.mineId))
    }
  }
  const named = session.focusedPin ?? null
  const focus =
    named !== null && pins.some((pin) => pin.key === named) ? named : (pins[0]?.key ?? null)
  return { pins, focus, dragging: null, talkedTo: { ...(session.talkedTo ?? {}) } }
}

/** S29.06: the tab ← or → moves keyboard focus to, wrapping at both ends; the selection is unchanged. */
export function arrowTarget(
  set: { readonly pins: readonly { readonly key: PinKey }[] },
  from: PinKey,
  key: 'ArrowLeft' | 'ArrowRight'
): PinKey {
  const at = set.pins.findIndex((pin) => pin.key === from)
  if (at < 0 || set.pins.length === 0) return from
  const step = key === 'ArrowRight' ? 1 : -1
  return set.pins[(at + step + set.pins.length) % set.pins.length]!.key
}

/** What a pin's words read of the Host's facts. */
export interface PinTextFacts {
  /** A present dwarf's name, status and the kind of its open ask; `null` for a dwarf the Host no longer lists. */
  dwarf(
    dwarfId: DwarfId
  ): { name: string; status: DwarfStatus; ask: 'permission' | 'question' | null } | null
  mineName(mineId: MineId): string | null
  /** The last name this window knew for a dwarf that left (a gone pin's). */
  knownName?(dwarfId: DwarfId): string | null
}

/** A pin's words (`DS/docs/copy.md`, Chat tab and Pinned chat stack). */
export interface PinText {
  readonly name: string
  /** A stack line's state text. */
  readonly line: string
  /** A tab's glyph: "?" while the dwarf needs the person, else nothing (the portrait carries the state). */
  readonly tab: string
  /** The dwarf needs the person: the line's state reads in brass. */
  readonly needs: boolean
  readonly lineLabel: string
  readonly tabLabel: string
  readonly unpinLabel: string
}

/** A gone pin whose dwarf this window never saw has no name to show; the design gives none. */
export const UNKNOWN_PIN_NAME = '⟦COPY NEEDED: name of a gone pin restored after a restart⟧'

/** The status words (PO #9: never "done"). */
const STATUS_WORD = {
  working: 'working',
  asleep: 'asleep',
  idle: 'idle',
  asking: '? asking'
} as const satisfies Record<DwarfStatus, string>

function words(name: string, state: string, needs: boolean, tab: string, line = state): PinText {
  const said = needs ? 'needs you' : state
  return {
    name,
    line,
    tab,
    needs,
    lineLabel: `${name}, ${said}. Open this chat`,
    tabLabel: `${name}, ${said}`,
    unpinLabel: `Unpin ${name}`
  }
}

/**
 * S29.15: a line reads "! permission" or "? asking" while its dwarf asks, else its status word, never "done"; a tab
 * carries only "?". A gone pin reads "gone" (S29.13). An Add pin reads "New dwarf", "in `<mine name>`" (S29.16).
 */
export function pinText(pin: Pin, facts: PinTextFacts): PinText {
  if (pin.kind === 'add') {
    const where = `in ${facts.mineName(pin.mineId) ?? 'a mine'}`
    return words('New dwarf', where, false, '')
  }
  const dwarf = pin.state === 'live' ? facts.dwarf(pin.dwarfId) : null
  const name = facts.dwarf(pin.dwarfId)?.name ?? facts.knownName?.(pin.dwarfId) ?? UNKNOWN_PIN_NAME
  if (pin.state === 'gone') return words(name, 'gone', false, '')
  if (dwarf === null) return words(name, '', false, '')
  const ask = dwarf.ask ?? (dwarf.status === 'asking' ? 'question' : null)
  if (ask === null) return words(name, STATUS_WORD[dwarf.status], false, '')
  return words(name, '', true, '?', ask === 'permission' ? '! permission' : '? asking')
}

/** A pin as the stack and the deck draw it. */
export interface PinView {
  readonly key: PinKey
  readonly kind: Pin['kind']
  readonly mineId: MineId
  /** `live` or `gone` for a chat pin (machine 18), `add` for the Add panel. */
  readonly state: PinnedChatState | 'add'
  /** A gone pin's chat is read-only (S18.02). */
  readonly readOnly: boolean
  readonly text: PinText
}

/** The set's pins in order, each with its words. */
export function pinViews(set: PinSet, facts: PinTextFacts): PinView[] {
  return set.pins.map((pin) => ({
    key: pin.key,
    kind: pin.kind,
    mineId: pin.mineId,
    state: pin.kind === 'chat' ? pin.state : 'add',
    readOnly: pin.kind === 'chat' && isChatReadOnly(pin.state),
    text: pinText(pin, facts)
  }))
}

/** A request to move keyboard focus, numbered so the same target asked twice is heard twice. */
export interface FocusRequest {
  readonly target: PinKey | 'container'
  readonly seq: number
}
