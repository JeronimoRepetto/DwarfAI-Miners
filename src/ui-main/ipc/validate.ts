// The seam A gate of Electron main (ADR-019 items 7, 8; 14 §1.4, §1.5, §3.3; 18 C-06, C-07; NFR-SEC-08): before the
// router dispatches a renderer call, the sender is checked first, then the payload is `parse()`d with the row's
// strict schema for the shape its route exposes (21 §1 item 2a). A refused call never reaches a handler and never
// throws; it is answered with the row's typed refusal (14 §1.5).
import {
  CHANNELS,
  todayShapeOf,
  type ChannelKey,
  type IpcError,
  type IpcErrorCode
} from '@dwarfai/contracts'
import type { ChannelRoute } from './channelRoute'
import { isAllowedSender, type IpcSenderEvent, type SenderPolicy } from './senderCheck'

/** The shape a route exposes in this release (21 §1 item 2a). */
export type RouteShape = ChannelRoute['shape']

/** The call errors this gate produces (14 §3.3). */
export type GateErrorCode = Extract<IpcErrorCode, 'INVALID_PARAMS' | 'SENDER_REJECTED'>

/**
 * A KEEP member's legacy failure shape, and today's for a row served with today's shape (14 §1.5, "through the
 * per-row adapter"): either today's own refusal value, or the state as it is, read by a read-only row of the same
 * today response with no payload (a setter answers with what is stored, 14 §1.4; A-43 "as the unchanged value",
 * A-48 "`JevSettings` unchanged").
 */
export type LegacyRefusal = { answer: unknown } | { unchanged: ChannelKey }

/** How a refused call is answered. */
export type Refusal =
  /** `IpcResult {ok:false, error}` (14 §1.5, §3.3). */
  | { kind: 'error'; error: IpcError }
  /** The row's legacy failure value. */
  | { kind: 'answer'; value: unknown }
  /** The row's legacy failure shape is the unchanged state: the router answers what `reader` answers now. */
  | { kind: 'unchanged'; reader: ChannelKey }
  /** A one-way send has no reply: the call is dropped (and counted by the router). */
  | { kind: 'drop' }

export type CallVerdict =
  { ok: true; payload: unknown } | { ok: false; code: GateErrorCode; refusal: Refusal }

/**
 * Today's refusal of every invoke row served with today's shape, taken from today's handler for a payload its
 * boundary refuses (`src/legacy-bridge/LegacyRuntimeRoute.ts`, carried unchanged from `src/main/index.ts`). A row
 * whose today handler has no refusal (a read, or a setter that answers the state in force) answers the unchanged
 * state; an action with an effect and no payload (a picker, a reset) answers today's "nothing happened" value, so
 * no effect runs. Every text is today's; none is new.
 */
export const LEGACY_REFUSALS: Partial<Record<ChannelKey, LegacyRefusal>> = {
  'panel:getAlwaysOnTop': { unchanged: 'panel:getAlwaysOnTop' },
  'panel:setAlwaysOnTop': { unchanged: 'panel:getAlwaysOnTop' },
  'panel:visible:get': { unchanged: 'panel:visible:get' },
  'audio:preferences:get': { unchanged: 'audio:preferences:get' },
  'audio:preferences:set': { unchanged: 'audio:preferences:get' },
  'panel:layout:get': { unchanged: 'panel:layout:get' },
  'panel:layout:set': { unchanged: 'panel:layout:get' },
  'shortcut:get': { unchanged: 'shortcut:get' },
  'shortcut:set': { unchanged: 'shortcut:get' },
  'mines:get': { unchanged: 'mines:get' },
  'dwarf:activate': { answer: { focused: false, openedTerminal: false, feed: [] } },
  'dwarf:feed': { answer: { readable: false, messages: [] } },
  'dwarf:feed:page': { answer: { readable: false, messages: [], reachedStart: false } },
  'dwarf:setTuning': {
    answer: { applied: false, reason: 'The panel is not holding this session.' }
  },
  'mine:history': { answer: { readable: false, speakers: [] } },
  'mine:openPath': {
    answer: { opened: false, reason: "That path is outside this mine's folder." }
  },
  'shell:openExternalLink': { answer: { opened: false, reason: 'That link could not be opened.' } },
  'shell:copyText': { answer: { copied: false } },
  'dwarf:sendText': {
    answer: { delivered: false, via: 'none', error: 'The message could not be delivered.' }
  },
  'dwarf:attachments:choose': { answer: [] },
  'dwarf:attachments:describe': { answer: [] },
  'dwarf:kick': {
    answer: { delivered: false, via: 'none', error: 'The kick could not be delivered.' }
  },
  'app:build': { unchanged: 'app:build' },
  'app:features': { unchanged: 'app:features' },
  'mine:declare': { answer: { outcome: 'cancelled' } },
  'mine:declare-main': { answer: { outcome: 'cancelled' } },
  'mine:undeclare': { answer: { outcome: 'unchanged', reason: 'No mine was named.' } },
  'metrics:reset': { answer: { outcome: 'failed' } },
  'projects:query': {
    answer: {
      answered: false,
      projects: [],
      reason: 'That is not a search this panel can run.'
    }
  },
  'agent:launch': {
    answer: { launched: false, provider: 'none', error: 'The agent could not be started.' }
  },
  'agent:providers': { unchanged: 'agent:providers' },
  'agent:models': { unchanged: 'agent:models' },
  'agent:launchHeld': { answer: { launched: false, error: 'The agent could not be started.' } },
  'agent:launchHosted': {
    answer: { launched: false, error: 'That command could not be started.' }
  },
  'agent:answerQuestion': {
    answer: { answered: false, error: 'That answer could not be delivered.' }
  },
  'agent:answerPermission': {
    answer: { answered: false, error: 'That answer could not be delivered.' }
  },
  'notifications:enabled:get': { unchanged: 'notifications:enabled:get' },
  'notifications:enabled:set': { unchanged: 'notifications:enabled:get' },
  'typography:preferences:get': { unchanged: 'typography:preferences:get' },
  'typography:preferences:set': { unchanged: 'typography:preferences:get' },
  'jev:settings:get': { unchanged: 'jev:settings:get' },
  'jev:apiKey:set': { unchanged: 'jev:settings:get' },
  'jev:apiKey:clear': { unchanged: 'jev:settings:get' },
  'jev:route': { answer: { kind: 'fallback', reason: 'invalid-response' } },
  'jev:preferences:set': { unchanged: 'jev:settings:get' },
  'opencode:settings:get': { unchanged: 'opencode:settings:get' },
  'opencode:plugin:set': { unchanged: 'opencode:settings:get' },
  'opencode:password:set': { unchanged: 'opencode:settings:get' },
  'opencode:password:clear': { unchanged: 'opencode:settings:get' },
  'launch-view:get': { unchanged: 'launch-view:get' },
  'dwarf:setName': {
    answer: { saved: false, reason: 'This dwarf is no longer here, so its name cannot change.' }
  },
  'dwarf:resetName': {
    answer: { saved: false, reason: 'This dwarf is no longer here, so its name cannot change.' }
  }
}

/**
 * `validateCall(channel, event, payload, shape)`: the gate of one renderer call, where `shape` is the shape of the
 * route that serves it. A call with no route (`shape` undefined) is only sender-checked: its payload reaches nothing,
 * and the router refuses it as unrouted.
 */
export type ValidateCall = (
  channel: ChannelKey,
  event: IpcSenderEvent,
  payload: unknown,
  shape: RouteShape | undefined
) => CallVerdict

/** A call error of this gate; the message is diagnostics only and never carries the payload (14 §1.5, §1.10). */
function callError(code: GateErrorCode, channel: ChannelKey): IpcError {
  const message =
    code === 'SENDER_REJECTED' ? `sender rejected for ${channel}` : `invalid params for ${channel}`
  return { code, message, retryable: false }
}

/** The row's request schema for the shape its route exposes; none for a today route of a row with no today shape. */
function requestSchemaOf(channel: ChannelKey, shape: RouteShape) {
  return shape === 'today' ? todayShapeOf(channel)?.request : CHANNELS[channel].request
}

/**
 * The typed refusal of a row (14 §1.5): a one-way send has no reply; an unknown sender is answered
 * `SENDER_REJECTED` and nothing of the app's state (a KEEP member's legacy failure shape may be live state, such
 * as `JevSettings`) reaches it; an invalid payload on a CHANGE or NEW row served with its target shape is answered
 * `IpcResult {ok:false, error: INVALID_PARAMS}`; every other invalid payload — a KEEP or RETIRE row, or any row
 * served with today's shape — answers the row's legacy failure shape.
 */
function refusalOf(channel: ChannelKey, code: GateErrorCode, shape: RouteShape): Refusal {
  const { kind, status } = CHANNELS[channel]
  if (kind !== 'invoke') return { kind: 'drop' }
  const typed =
    code === 'SENDER_REJECTED' || (shape === 'target' && status !== 'kept' && status !== 'retired')
  const legacy = typed ? undefined : LEGACY_REFUSALS[channel]
  if (legacy === undefined) return { kind: 'error', error: callError(code, channel) }
  return 'answer' in legacy
    ? { kind: 'answer', value: legacy.answer }
    : { kind: 'unchanged', reader: legacy.unchanged }
}

/** The gate, bound to the sender policy of this Electron main. Never throws. */
export function createValidateCall(senders: SenderPolicy): ValidateCall {
  return (channel, event, payload, shape) => {
    const refuse = (code: GateErrorCode): CallVerdict => ({
      ok: false,
      code,
      refusal: refusalOf(channel, code, shape ?? 'target')
    })
    // The sender first: nothing an unknown sender sent is even parsed.
    if (!isAllowedSender(event, senders)) return refuse('SENDER_REJECTED')
    if (shape === undefined) return { ok: true, payload }
    const schema = requestSchemaOf(channel, shape)
    if (schema === undefined || !schema.safeParse(payload).success) return refuse('INVALID_PARAMS')
    // The checked value itself goes on, so a valid call is served exactly as today.
    return { ok: true, payload }
  }
}
