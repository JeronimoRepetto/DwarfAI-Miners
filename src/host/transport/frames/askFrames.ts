// The ask frames of seam B (14 §2.4 B-F15…B-F17; 14 §3.5, frozen; ADR-010 item 6; 08 §2.7),
// projected from the asking module's events for `ui` connections only, never a notifier or a
// viewer (roles.ts):
//
// - `AskOpened` → `ask.opened {ask}`: a new card.
// - `AskReopened` → `ask.opened {ask}` re-sent with the same `askId`: a refused answer put the ask
//   back to `open` and its card comes back with no alert (PO #91; US-ASK-007). The event carries
//   no record (08 §0), so the projection reads the dwarf's open ask through `AskQueries.openAskOf`:
//   the reopened ask is that dwarf's front ask, the one ask that could be `answering` (ADR-010
//   item 4). Should it no longer be the front open ask when the event is handled, no card is
//   re-sent: the event that moved it on sends its own frame.
// - `AskClosed` → `ask.closed {askId, dwarfId, reason}`: the card disappears, with no notice
//   (PO #22). An `auto-denied` ask publishes only `AskClosed` (ADR-010 item 12), so it never gets
//   an `ask.opened`.
// - `AskStepChanged` → `ask.step {askId, currentStep}`: other windows follow the step (OQ-03).
//
// Each event is published after the commit of the rows it reports (16 §2.3) and handled
// synchronously, so its frame follows that commit and its seq is greater than that of any
// snapshot whose `asks` were read before it (14 §4.2). `ask.opened` is a sensitive frame (14 §3.5
// SENSITIVE_FRAMES: question steps, tool summaries): the transport logs its name, seq and size
// only, and nothing here logs. Routed by the asking wiring (later: ISSUE-140).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { AskingEvent, AskQueries, AskRecord } from '../../modules/asking'
import type { FrameAudience } from '../events/framePublisher'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const ASK_FRAMES: readonly HostFrameName[] = Object.freeze([
  'ask.opened',
  'ask.closed',
  'ask.step'
])

/** Where the frames go: the connection registry (connectionRegistry.ts). */
export interface AskFramePublisher {
  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void
}

export interface AskFramesDeps {
  /** The asking module's events on the Host's bus (16 §2.3). */
  events: Pick<DomainEventBus<AskingEvent>, 'subscribe'>
  /** The reopened ask's record (the `AskReopened` payload carries none, 08 §0). */
  asks: Pick<AskQueries, 'openAskOf'>
  frames: AskFramePublisher
}

/**
 * ADR-010's `AskRecord` as 14 §3.5 sends it: every field the record has, nothing else (the frame
 * schema is strict(), 14 §1.4), and `closedAt` only when set.
 */
export function toAskWire(ask: AskRecord): HostFrameData['ask.opened']['ask'] {
  return {
    id: ask.id,
    dwarfId: ask.dwarfId,
    kind: ask.kind,
    channel: ask.channel,
    providerRequestId: ask.providerRequestId,
    payload: ask.payload,
    currentStep: ask.currentStep,
    state: ask.state,
    reannounce: ask.reannounce,
    openedAt: ask.openedAt,
    ...(ask.closedAt === undefined ? {} : { closedAt: ask.closedAt })
  }
}

/** Routes the four asking events to their frames; returns the unsubscribe. */
export function publishAskFrames(deps: AskFramesDeps): () => void {
  const stops = [
    deps.events.subscribe('AskOpened', (event) => {
      deps.frames.publishFrame('ask.opened', { ask: toAskWire(event.payload.ask) })
    }),
    deps.events.subscribe('AskReopened', (event) => {
      const ask = deps.asks.openAskOf(event.payload.dwarfId)
      if (ask === null || ask.id !== event.payload.askId) return
      deps.frames.publishFrame('ask.opened', { ask: toAskWire(ask) })
    }),
    deps.events.subscribe('AskClosed', (event) => {
      const { askId, dwarfId, reason } = event.payload
      deps.frames.publishFrame('ask.closed', { askId, dwarfId, reason })
    }),
    deps.events.subscribe('AskStepChanged', (event) => {
      const { askId, currentStep } = event.payload
      deps.frames.publishFrame('ask.step', { askId, currentStep })
    })
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
