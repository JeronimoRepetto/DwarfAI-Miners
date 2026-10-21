// Machine 9 of 07, "Chat hand-off between modes" (OQ-37 B, PO #99; ADR-024 item 3; ADR-025 item 3; ISSUE-293): the
// same chat moving between the mode windows as one continuous motion, with its draft, scroll anchor and caret or
// selection. The transitions 07 lists, as a table. Pure: no I/O, no clock. The `ModeCoordinator` steps it for a run
// that carries a chat (machine 27 is the run, machine 9 the chat it carries); each renderer does its half of the
// state transfer through the UI-main session store.
//
// - S9.01: a mode control with an open chat pre-sizes the target (its guard: the target mode is built, BR-19).
// - S9.02: the source flushed the draft and `ChatViewState` before `t0`; an IME composition in progress ends at the
//   switch and is never carried.
// - S9.03 / S9.04 / S9.05: both renderers done, the motion watchdog, or reduced motion: the same end state, the
//   source hidden and the target focused; into Veta the chat rises once landed (S24.18).
// - S9.06: the target fails to show: the chat stays in the source; logged, nothing else (architect-proposed, §24 I-12).
// - S9.07: the window going hidden mid-motion resolves at once; restoring shows the target.
// - S9.08: the dwarf departs during the hand-off: read-only in the target for any cause but `mine-removed`, which
//   closes it. With no cause known here the target decides from its own departure fact.
// - S9.09: a UI crash loses drafts and view state, never persisted, and nothing else (the Host is intact).
import type { DepartureCause, DwarfId, MineId, Outcome, WindowMode } from '@dwarfai/contracts'

export type ChatHandoffState = 'in-source' | 'flushing' | 'transitioning' | 'in-target' | 'lost'

/** How the chat ends in the target: live, read-only or closed by a departure (S9.08), or hidden mid-motion (S9.07). */
export type ChatHandoffEnding = 'live' | 'read-only' | 'closed' | 'hidden'

export interface ChatHandoffNode {
  state: ChatHandoffState
  /** The chat carried. */
  chat: { dwarfId: DwarfId; mineId: MineId }
  /** The mode the chat is open in when the hand-off starts. */
  from: WindowMode
  /** The mode it moves to, once a mode control named it. */
  to?: WindowMode
  /** Set in `in-target`; absent after S9.08 when the cause is not known here. */
  ending?: ChatHandoffEnding
}

export type ChatHandoffEvent =
  /** `UI:` a mode control with a chat (S9.01); `built` is its guard. */
  | { type: 'mode-control'; to: WindowMode; built: boolean }
  /** The source flushed the draft and view state before `t0` (S9.02). */
  | { type: 'flushed' }
  /** Both renderers answered `done` (S9.03). */
  | { type: 'done' }
  /** `timer:` the motion watchdog (S9.04). */
  | { type: 'watchdog' }
  /** Reduced motion: durations 0 ms (S9.05). */
  | { type: 'reduced-motion' }
  /** The target window fails to show, or the flush fails (S9.06). */
  | { type: 'target-failed' }
  /** The window going hidden mid-motion (S9.07). */
  | { type: 'hidden' }
  /** `DwarfDeparted` of the carried dwarf (S9.08), with its cause when known. */
  | { type: 'departed'; cause?: DepartureCause }
  /** The UI process crashed (S9.09). */
  | { type: 'crashed' }

export type ChatHandoffEffect =
  /** S9.01: the target window placed at its final bounds, content at opacity 0, shown inactive. */
  | 'pre-size-target'
  /** S9.02: an in-progress IME composition ends at the switch. */
  | 'end-ime'
  | 'hide-source'
  | 'focus-target'
  /** S9.03 into Veta: the chat rises M + 60 ms after the shell motion (S24.18). */
  | 'rise-after-landing'
  /** S9.06: `window.transition-failed`. */
  | 'log-failed'
  /** S9.09: drafts and view state are gone with the UI process. */
  | 'lose-drafts-and-views'

export interface ChatHandoffStep {
  /** The 07 transition id. */
  id: 'S9.01' | 'S9.02' | 'S9.03' | 'S9.04' | 'S9.05' | 'S9.06' | 'S9.07' | 'S9.08' | 'S9.09'
  to: ChatHandoffNode
  effects: readonly ChatHandoffEffect[]
}

/** Why no transition fires: 07 lists none here, or S9.01's guard (the target mode is not built). */
export type ChatHandoffRefusal = 'not-listed' | 'not-built'

/** A chat open in `from`, before any mode control. */
export function startChatHandoff(chat: ChatHandoffNode['chat'], from: WindowMode): ChatHandoffNode {
  return { state: 'in-source', chat, from }
}

const ok = (
  id: ChatHandoffStep['id'],
  to: ChatHandoffNode,
  effects: readonly ChatHandoffEffect[] = []
): Outcome<ChatHandoffStep, ChatHandoffRefusal> => ({ ok: true, value: { id, to, effects } })
const refused = (error: ChatHandoffRefusal): Outcome<ChatHandoffStep, ChatHandoffRefusal> => ({
  ok: false,
  error
})

/** The chat landed in the target, ending as `ending`. */
function landed(node: ChatHandoffNode, ending?: ChatHandoffEnding): ChatHandoffNode {
  const to: ChatHandoffNode = { state: 'in-target', chat: node.chat, from: node.from }
  if (node.to !== undefined) to.to = node.to
  if (ending !== undefined) to.ending = ending
  return to
}

/** S9.03–S9.05's end state: the source hidden, the target focused, and into Veta the rise once landed. */
function landedEffects(node: ChatHandoffNode): ChatHandoffEffect[] {
  const effects: ChatHandoffEffect[] = ['hide-source', 'focus-target']
  if (node.to === 'veta') effects.push('rise-after-landing')
  return effects
}

/** S9.08: read-only for any cause but `mine-removed`, which closes the chat. */
function departedEnding(cause: DepartureCause | undefined): ChatHandoffEnding | undefined {
  if (cause === undefined) return undefined
  return cause === 'mine-removed' ? 'closed' : 'read-only'
}

/** The next node of machine 9 from `node` on `event`. */
export function nextChatHandoff(
  node: ChatHandoffNode,
  event: ChatHandoffEvent
): Outcome<ChatHandoffStep, ChatHandoffRefusal> {
  if (node.state === 'lost') return refused('not-listed')
  // S9.09: any state; the drafts and the view state go with the UI process, nothing else does.
  if (event.type === 'crashed') {
    return ok('S9.09', { state: 'lost', chat: node.chat, from: node.from }, [
      'lose-drafts-and-views'
    ])
  }
  // S9.08: during the hand-off (`flushing` or `transitioning`).
  if (event.type === 'departed') {
    if (node.state !== 'flushing' && node.state !== 'transitioning') return refused('not-listed')
    return ok('S9.08', landed(node, departedEnding(event.cause)), ['hide-source', 'focus-target'])
  }
  switch (node.state) {
    case 'in-source':
      if (event.type !== 'mode-control') return refused('not-listed')
      if (!event.built) return refused('not-built')
      return ok('S9.01', { ...node, state: 'flushing', to: event.to }, ['pre-size-target'])
    case 'flushing':
      if (event.type === 'flushed')
        return ok('S9.02', { ...node, state: 'transitioning' }, ['end-ime'])
      if (event.type === 'reduced-motion') {
        // S9.05: durations 0 ms, the same state transfer, so the IME still ends at the switch.
        return ok('S9.05', landed(node, 'live'), ['end-ime', ...landedEffects(node)])
      }
      if (event.type === 'target-failed') {
        return ok('S9.06', { state: 'in-source', chat: node.chat, from: node.from }, ['log-failed'])
      }
      return refused('not-listed')
    case 'transitioning':
      if (event.type === 'done') return ok('S9.03', landed(node, 'live'), landedEffects(node))
      if (event.type === 'watchdog') return ok('S9.04', landed(node, 'live'), landedEffects(node))
      // S9.07: resolves at once; nothing takes the focus while the windows are hidden.
      if (event.type === 'hidden') return ok('S9.07', landed(node, 'hidden'), ['hide-source'])
      return refused('not-listed')
    case 'in-target':
      return refused('not-listed')
  }
}
