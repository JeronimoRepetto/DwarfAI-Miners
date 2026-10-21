/*
 * 07 machine 24, the risen window above the Veta strip: a dwarf's chat or the Add panel (US-VETA-004, US-VETA-005;
 * UC-048, UC-066; ISSUE-290), and its geometry. Pure: no DOM, no clock, no `window.api`. The Veta renderer feeds it
 * what the person and the Host did and carries out, in order, the effects each step names (`useVetaRisen`).
 *
 * - A click, Enter or Space on a dwarf's sprite rises its chat (S24.01): the window grows first (`layoutVeta {rise}`),
 *   the session store learns the open chat and gives its draft and view back, then the chat rises; once risen the
 *   composer, or the question card while the dwarf asks, takes the keyboard (S24.02). Never from a press that became a
 *   drag. A hover opens nothing (S24.19), nor does a press near a dwarf that misses it (S24.20).
 * - "+ New dwarf" on a mine tab or a picker pick rises the Add panel aimed at that mine (S24.03, S24.04); the launch
 *   sent from it turns it into the new dwarf's chat where it stands (S24.06), a failed one shows inside it (S24.07).
 * - Another dwarf's click replaces the content (S24.05): the old chat's draft and view kept, the content veiled, the
 *   window re-anchored, and the new chat faded in.
 * - A press outside the window (the strip included, so the open dwarf itself) or Esc folds it, the draft kept (S24.08);
 *   the window shrinks only after the fold (S24.09). Esc in an active rename field is the field's own.
 * - The dwarf's process closing leaves the chat read-only with its draft dropped (S24.10, INV-113); its mine removed, or
 *   the Add panel's, closes it outright with nothing kept (S24.11).
 * - A drag, the display gone or the window hidden fold it at once (S24.14); after a drag UI main already forgot the
 *   room, so no fold is asked. A reveal rises the chat as a click does, or brings only the mine when the dwarf left
 *   (S24.15, S24.16). A rise the window could not grow for shows nothing and is logged (S24.17). The UI process gone,
 *   the next start is folded with nothing kept (S24.21).
 *
 * "▢ Open in the Panel" asks for the Panel on the chat's mine and dwarf (S24.12), the run carrying the chat; the window
 * folds when it hides (S24.14). A mode change into Veta carrying a chat rises it as a click does, once landed (S24.18).
 * The history request (S24.13) waits on the Panel being able to open on the history (`ModeTransition.slot`, an
 * amendment), so it is not modelled yet (ISSUE-293). A step 07 does not list is rejected and the machine is held.
 *
 * The geometry (DS/docs/screens/veta.md, Layout; the prototype's `veta.js` numbers): 444 px wide, as tall as the room
 * beside the strip less 40 px held between 360 and 600 px, 14 px from the strip, centred on the dwarf or button that
 * opened it then clamped 12 px inside the stage, its stepped pointer at least 18 px from its ends. The window grows
 * away from the island's anchor corner (V4, "The anchor corner is fixed"), so the risen window never passes the
 * island's anchored end: near it the window stops at that end, never more than the dock's offset less 12 px from where
 * the stage clamp alone would put it (a package gap resolved in ISSUE-290).
 */
import type { DepartureCause, DwarfId, MineId, VetaDock } from '@dwarfai/contracts'

export type RisenState =
  'folded' | 'rising' | 'risen-chat' | 'risen-add' | 'read-only' | 'replacing' | 'folding'

/** What the risen window holds: one dwarf's chat, or the Add panel aimed at a mine. */
export type RisenContent =
  | { readonly kind: 'chat'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  | { readonly kind: 'add'; readonly mineId: MineId }

export interface RisenWindow {
  readonly state: RisenState
  /** `null` while `folded`. */
  readonly content: RisenContent | null
}

export interface RisenContext {
  /** A grip drag is under way (07 machine 21). */
  readonly dragging: boolean
}

export type RisenEvent =
  /** A click, Enter or Space on a dwarf's sprite itself. */
  | { readonly type: 'dwarf-hit'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  /** The pointer on a dwarf. */
  | { readonly type: 'hover'; readonly dwarfId: DwarfId }
  /** A press near a dwarf that missed it, while folded. */
  | { readonly type: 'near-miss' }
  /** "+ New dwarf" on a mine tab (S23.05) or a mine picker pick (S22.09). */
  | { readonly type: 'add'; readonly mineId: MineId }
  /** The motion under way ended, by its own end or its watchdog. */
  | { readonly type: 'motion-done' }
  /** The launch sent from this Add panel has its dwarf (`DwarfLaunched`). */
  | { readonly type: 'launched'; readonly dwarfId: DwarfId }
  /** The launch sent from this Add panel failed (`LaunchFailed`). */
  | { readonly type: 'launch-failed' }
  /** A press outside the risen window, the strip included. */
  | { readonly type: 'outside' }
  /** Esc; `renaming` while the chat header's rename field is active. */
  | { readonly type: 'esc'; readonly renaming: boolean }
  /** `dwarf.departed` of a dwarf, with its cause. */
  | { readonly type: 'departed'; readonly dwarfId: DwarfId; readonly cause: DepartureCause }
  /** A mine was removed. */
  | { readonly type: 'mine-removed'; readonly mineId: MineId }
  /** A drag started, Veta's display went away, or the window was hidden. */
  | { readonly type: 'interrupt'; readonly why: 'drag' | 'display' | 'hidden' }
  /** `onRevealDwarfChat` while Veta is the mode; `present` whether the named dwarf is still there. */
  | {
      readonly type: 'reveal'
      readonly mineId: MineId
      readonly dwarfId: DwarfId | null
      readonly present: boolean
    }
  /** `layoutVeta {rise}` answered `applied: false`. */
  | { readonly type: 'refused' }
  /** The UI process crashed or the app closed. */
  | { readonly type: 'lost' }
  /** "▢ Open in the Panel" in the chat header (S24.12). */
  | { readonly type: 'open-in-panel' }
  /** A mode change into Veta carrying a chat landed (S24.18); `present` whether its dwarf is still there. */
  | {
      readonly type: 'arrive'
      readonly mineId: MineId
      readonly dwarfId: DwarfId
      readonly present: boolean
    }

export type RisenEffect =
  /** `layoutVeta {rise, dwarfId, chatBounds}`: the window grows for the chat before anything shows. */
  | { readonly kind: 'layout-rise'; readonly dwarfId: DwarfId }
  /** The window grows for the Add panel before it shows. */
  | { readonly kind: 'layout-add'; readonly mineId: MineId }
  /** `patchUiSession` `veta-risen-chat`, `open-chat{veta}`; the chat's draft and view state restored. */
  | { readonly kind: 'open-chat'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  /** The Add panel opens aimed at the mine. */
  | { readonly kind: 'open-add'; readonly mineId: MineId }
  /** A motion of the content (`transform`/`opacity` only): rise, veil (to opacity 0 at once), replace or fold. */
  | { readonly kind: 'motion'; readonly motion: 'rise' | 'veil' | 'replace' | 'fold' }
  /** The keyboard to the chat (composer, or the question card) or to the Add panel's first supplier chip. */
  | { readonly kind: 'focus'; readonly target: 'chat' | 'add' }
  /** The chat's draft and view state kept in the session store. */
  | { readonly kind: 'keep'; readonly dwarfId: DwarfId }
  /** The chat's draft dropped (INV-113). */
  | { readonly kind: 'drop-draft'; readonly dwarfId: DwarfId }
  /** `layoutVeta {fold}`: the window shrinks, after the fold. */
  | { readonly kind: 'layout-fold' }
  /** `patchUiSession` `veta-risen-chat: null`. */
  | { readonly kind: 'closed' }
  /** Only the mine's chamber brought into view (S25.08 when folded, ISSUE-291). */
  | { readonly kind: 'bring-mine'; readonly mineId: MineId }
  /** The refused rise logged (`veta.placement`, `unplaced`). */
  | { readonly kind: 'log-refused' }
  /** `moveToMode {mode: 'panel', mineId, dwarfId}`: machine 27 runs the move, machine 9 carries the chat. */
  | { readonly kind: 'move-to-panel'; readonly mineId: MineId; readonly dwarfId: DwarfId }

export type RisenStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      readonly from: RisenState
      readonly to: RisenState
      readonly effects: readonly RisenEffect[]
    }
  | { readonly ok: false; readonly from: RisenState; readonly event: RisenEvent['type'] }

export const FOLDED: RisenWindow = { state: 'folded', content: null }

/** The risen window's numbers (DS/docs/screens/veta.md, "Numbers written in the scripts"). */
export const RISEN = {
  /** The chat or Add panel window's width. */
  width: 444,
  /** Its height: the room beside the strip less `margin`, held between these two. */
  minHeight: 360,
  maxHeight: 600,
  margin: 40,
  /** From the strip. */
  gap: 14,
  /** From the stage's sides. */
  inset: 12,
  /** The pointer at least this far from the window's ends. */
  pointerEnd: 18
} as const

interface Next {
  readonly id: string
  readonly to: RisenWindow
  readonly effects?: readonly RisenEffect[]
}

const chatOf = (dwarfId: DwarfId, mineId: MineId): RisenContent => ({
  kind: 'chat',
  dwarfId,
  mineId
})

/** S24.01 / S24.15: the window grows, the store learns the chat, it rises. */
function rise(dwarfId: DwarfId, mineId: MineId, id: string): Next {
  return {
    id,
    to: { state: 'rising', content: chatOf(dwarfId, mineId) },
    effects: [
      { kind: 'layout-rise', dwarfId },
      { kind: 'open-chat', dwarfId, mineId },
      { kind: 'motion', motion: 'rise' }
    ]
  }
}

/** S24.08 / S24.11: the fold plays; a live chat keeps its draft and view first. */
function fold(machine: RisenWindow, id: string, keep: boolean): Next {
  const content = machine.content
  const effects: RisenEffect[] = []
  if (keep && content?.kind === 'chat') effects.push({ kind: 'keep', dwarfId: content.dwarfId })
  effects.push({ kind: 'motion', motion: 'fold' })
  return { id, to: { state: 'folding', content }, effects }
}

/** The 07 transition an event takes from a machine, or `null` when 07 lists none. */
function transition(machine: RisenWindow, event: RisenEvent, context: RisenContext): Next | null {
  const { state, content } = machine
  const open = state === 'risen-chat' || state === 'risen-add' || state === 'read-only'
  const openChat = content?.kind === 'chat' ? content : null
  switch (event.type) {
    case 'dwarf-hit': {
      if (state === 'folded') {
        return context.dragging ? null : rise(event.dwarfId, event.mineId, 'S24.01')
      }
      if (!open) return null
      // The open dwarf itself is on the strip, outside the window.
      if (openChat !== null && openChat.dwarfId === event.dwarfId) {
        return fold(machine, 'S24.08', state === 'risen-chat')
      }
      const effects: RisenEffect[] = []
      if (state === 'risen-chat' && openChat !== null) {
        effects.push({ kind: 'keep', dwarfId: openChat.dwarfId })
      }
      effects.push(
        { kind: 'motion', motion: 'veil' },
        { kind: 'layout-rise', dwarfId: event.dwarfId },
        { kind: 'open-chat', dwarfId: event.dwarfId, mineId: event.mineId },
        { kind: 'motion', motion: 'replace' }
      )
      return {
        id: 'S24.05',
        to: { state: 'replacing', content: chatOf(event.dwarfId, event.mineId) },
        effects
      }
    }
    case 'hover':
      return state === 'folded' ? { id: 'S24.19', to: machine } : null
    case 'near-miss':
      return state === 'folded' ? { id: 'S24.20', to: machine } : null
    case 'add':
      if (state !== 'folded') return null
      return {
        id: 'S24.03',
        to: { state: 'rising', content: { kind: 'add', mineId: event.mineId } },
        effects: [
          { kind: 'layout-add', mineId: event.mineId },
          { kind: 'open-add', mineId: event.mineId },
          { kind: 'motion', motion: 'rise' }
        ]
      }
    case 'motion-done':
      if (state === 'rising') {
        return content?.kind === 'add'
          ? {
              id: 'S24.04',
              to: { state: 'risen-add', content },
              effects: [{ kind: 'focus', target: 'add' }]
            }
          : {
              id: 'S24.02',
              to: { state: 'risen-chat', content },
              effects: [{ kind: 'focus', target: 'chat' }]
            }
      }
      if (state === 'replacing') return { id: 'S24.05', to: { state: 'risen-chat', content } }
      if (state === 'folding') {
        return { id: 'S24.09', to: FOLDED, effects: [{ kind: 'layout-fold' }, { kind: 'closed' }] }
      }
      return null
    case 'launched': {
      if (state !== 'risen-add' || content?.kind !== 'add') return null
      const mineId = content.mineId
      return {
        id: 'S24.06',
        to: { state: 'risen-chat', content: chatOf(event.dwarfId, mineId) },
        effects: [{ kind: 'open-chat', dwarfId: event.dwarfId, mineId }]
      }
    }
    case 'launch-failed':
      return state === 'risen-add' ? { id: 'S24.07', to: machine } : null
    case 'outside':
      return open ? fold(machine, 'S24.08', state === 'risen-chat') : null
    case 'esc':
      if (!open || event.renaming) return null
      return fold(machine, 'S24.08', state === 'risen-chat')
    case 'departed': {
      if (openChat === null || openChat.dwarfId !== event.dwarfId) return null
      if (event.cause === 'mine-removed') {
        if (state !== 'risen-chat' && state !== 'read-only') return null
        const closing = fold(machine, 'S24.11', false)
        return {
          ...closing,
          effects: [{ kind: 'drop-draft', dwarfId: event.dwarfId }, ...(closing.effects ?? [])]
        }
      }
      if (state !== 'risen-chat') return null
      return {
        id: 'S24.10',
        to: { state: 'read-only', content },
        effects: [{ kind: 'drop-draft', dwarfId: event.dwarfId }]
      }
    }
    case 'mine-removed':
      if (state !== 'risen-add' || content?.kind !== 'add' || content.mineId !== event.mineId) {
        return null
      }
      return fold(machine, 'S24.11', false)
    case 'interrupt': {
      if (state === 'folded' || state === 'folding') return null
      const effects: RisenEffect[] = []
      if (state !== 'read-only' && openChat !== null) {
        effects.push({ kind: 'keep', dwarfId: openChat.dwarfId })
      }
      // After a drag UI main already forgot the room: the window is the drag surface now.
      if (event.why !== 'drag') effects.push({ kind: 'layout-fold' })
      effects.push({ kind: 'closed' })
      return { id: 'S24.14', to: FOLDED, effects }
    }
    case 'reveal':
      if (state !== 'folded') return null
      if (event.dwarfId !== null && event.present) {
        return rise(event.dwarfId, event.mineId, 'S24.15')
      }
      return {
        id: 'S24.16',
        to: FOLDED,
        effects: [{ kind: 'bring-mine', mineId: event.mineId }]
      }
    case 'refused':
      return state === 'rising'
        ? { id: 'S24.17', to: FOLDED, effects: [{ kind: 'log-refused' }] }
        : null
    case 'lost':
      return { id: 'S24.21', to: FOLDED }
    case 'open-in-panel':
      // S24.12: the run carries the chat (machine 9); it stays risen here until the window hides (S24.14).
      if (state !== 'risen-chat' || openChat === null) return null
      return {
        id: 'S24.12',
        to: machine,
        effects: [{ kind: 'move-to-panel', mineId: openChat.mineId, dwarfId: openChat.dwarfId }]
      }
    case 'arrive':
      // S24.18: the carried chat rises as a click raises it, its draft and view given back by the session store.
      if (state !== 'folded' || !event.present) return null
      return rise(event.dwarfId, event.mineId, 'S24.18')
  }
}

/** One step of machine 24: the next machine, and the transition taken or the refusal. */
export function stepRisen(
  machine: RisenWindow,
  event: RisenEvent,
  context: RisenContext
): { machine: RisenWindow; step: RisenStep } {
  const next = transition(machine, event, context)
  if (next === null) {
    return { machine, step: { ok: false, from: machine.state, event: event.type } }
  }
  return {
    machine: next.to,
    step: {
      ok: true,
      id: next.id,
      from: machine.state,
      to: next.to.state,
      effects: next.effects ?? []
    }
  }
}

const vertical = (edge: VetaDock['edge']): boolean => edge === 'left' || edge === 'right'

/**
 * The risen window's height: the room beside the strip less 40 px, held between 360 and 600 px. The room is the
 * stage's height less the island's thickness on a top or bottom edge, the stage's height on a side one.
 */
export function risenHeight(
  edge: VetaDock['edge'],
  stage: { width: number; height: number },
  thickness: number
): number {
  const room = vertical(edge) ? stage.height : stage.height - thickness
  return Math.max(RISEN.minHeight, Math.min(RISEN.maxHeight, room - RISEN.margin))
}

/** The island on its stage, along its edge: its length, and the stage's length before and after it. */
export interface RisenIsland {
  readonly length: number
  readonly thickness: number
  /** From the stage's start (its left or top) to the island's start. */
  readonly before: number
  /** From the island's end to the stage's end (its right or bottom). */
  readonly after: number
}

export interface RisenGeometry {
  /** The window's size: 444 px across a top or bottom edge's length, or across a side edge. */
  readonly width: number
  readonly height: number
  /** The pointer's centre along the window, from its start (left or top). */
  readonly pointer: number
  /** From the island's anchored end to the window's nearer end, along the edge. */
  readonly fromAnchor: number
  /** The room beside the island UI main grows the window by (`chatBounds`): from the anchored end, gap included. */
  readonly room: { readonly width: number; readonly height: number }
}

/**
 * Where the risen window stands for a target whose centre is `centre` px along the island from its start: centred on
 * it, clamped 12 px inside the stage and never past the island's anchored end.
 */
export function risenGeometry(
  dock: Pick<VetaDock, 'edge' | 'end'>,
  stage: { width: number; height: number },
  island: RisenIsland,
  centre: number
): RisenGeometry {
  const height = risenHeight(dock.edge, stage, island.thickness)
  const side = vertical(dock.edge)
  // Along the edge, in the island's own coordinates: it spans [0, length].
  const along = side ? height : RISEN.width
  const across = side ? RISEN.width : height
  const anchoredAtEnd = dock.end === 'end'
  const low = Math.max(-island.before + RISEN.inset, anchoredAtEnd ? -Infinity : 0)
  const high = Math.min(
    island.length + island.after - RISEN.inset - along,
    anchoredAtEnd ? island.length - along : Infinity
  )
  const start = Math.max(low, Math.min(centre - along / 2, high))
  const pointer = Math.max(RISEN.pointerEnd, Math.min(centre - start, along - RISEN.pointerEnd))
  const fromAnchor = anchoredAtEnd ? island.length - (start + along) : start
  const reach = anchoredAtEnd ? island.length - start : start + along
  const depth = RISEN.gap + across
  return {
    width: RISEN.width,
    height,
    pointer,
    fromAnchor,
    room: side ? { width: depth, height: reach } : { width: reach, height: depth }
  }
}
