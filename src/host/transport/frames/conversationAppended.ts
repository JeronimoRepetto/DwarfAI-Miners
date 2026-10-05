// The conversation frame of seam B (14 §2.4 B-F11; 14 §3.5, frozen): `conversation.appended
// {dwarfId, messages}`, projected from `MessagesAppended` (08 §0) for `ui` and the viewer bound to
// that dwarf (ADR-031 item 2), never a notifier (roles.ts).
//
// - The event is published after its batch's commit (16 §2.3) and handled synchronously, so the
//   frame follows the commit, and a frame's seq is greater than that of any snapshot whose `tails`
//   were read before the commit (14 §4.2, snapshot/tailsSection.ts).
// - The frame carries the rows the batch inserted, never a merged echo or a dropped record (08 §0),
//   each mapped to 14 §3.6 `MessageView` by mappers/wire.ts, so a frame row has the shape of a
//   `tails` row and of a `conversation.feed` row.
// - A batch that inserted nothing publishes no event, so sends no frame.
// - `conversation.appended` is a sensitive frame (14 §3.5 SENSITIVE_FRAMES: message text): the
//   transport logs its name, seq and size only, and nothing here logs.
// - Unbound until the composition root registers it over the wired conversation module (later:
//   ISSUE-108).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { ConversationEvent } from '../../modules/conversation'
import type { FrameAudience } from '../events/framePublisher'
import { toMessageWire } from '../mappers/wire'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const CONVERSATION_FRAMES: readonly HostFrameName[] = Object.freeze([
  'conversation.appended'
])

/** Where the frames go: the connection registry (connectionRegistry.ts). */
export interface ConversationFramePublisher {
  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void
}

export interface ConversationFramesDeps {
  /** The conversation module's events on the Host's bus (16 §2.3). */
  events: Pick<DomainEventBus<ConversationEvent>, 'subscribe'>
  frames: ConversationFramePublisher
}

/** Routes `MessagesAppended` to `conversation.appended`; returns the unsubscribe. */
export function publishConversationFrames(deps: ConversationFramesDeps): () => void {
  return deps.events.subscribe('MessagesAppended', (event) => {
    const { dwarfId, messages } = event.payload
    deps.frames.publishFrame(
      'conversation.appended',
      { dwarfId, messages: messages.map(toMessageWire) },
      { dwarfId }
    )
  })
}
