// The conversation module's frames of seam B (14 §2.4 B-F09, B-F11, B-F14; 14 §3.5, frozen; 08 §2.6,
// §3): the 05 §4 routes from conversation's events, published after their commit (08 §5.1, 16 §2.3)
// and handled synchronously, to `publishFrame` with the 14 §2.4 audiences (roles.ts filters the
// roles, the audience's `dwarfId` the viewer):
//
// - `MessagesAppended` → `conversation.appended {dwarfId, messages}` (B-F11), to `ui` and the viewer
//   of that dwarf (ADR-031 item 2): transport/frames/conversationAppended.ts.
// - `TurnEnded` → `turn.ended {dwarfId, turnKey, kind, reliability, cancelledFromApp}` (B-F14), to
//   `ui` only: one per turn, since conversation publishes `TurnEnded` only for a new
//   `turn:<dwarfId>:<turnKey>` fact (ADR-021; 08 §4). Built field by field from the ADR-021
//   `TurnEnded`: `at` and the provider's `detail` are not in the frame.
// - `OutcomeLineChanged` → `dwarf.changed {dwarf}` (B-F09), to `ui`: the whole dwarf as crew's `get`
//   reads it after the commit, carrying the new `outcome` (INV-67; mappers/wire.ts), as every board
//   frame carries the full read model (frames/board.ts). A dwarf no longer present sends nothing:
//   `dwarf.departed` is its last frame.
//
// Not routed, and why:
// - `ActivityChanged` → `activity.changed` (B-F13, `ActivityWire`): the frame carries the run's
//   `summaries`, which neither the event (08 §0: `{dwarfId, disclosureId, open, stepCount}`) nor a
//   member of the frozen `ConversationQueries` (16 §4.6) gives for a closed run (`ActivityLog.openRun`,
//   amendment A, reads only the open one, inside conversation's transaction). Blocked on an amendment
//   (ISSUE-108 hand-off), so the frame is not advertised (hidden until built, 21 §1 item 8).
// - The other `dwarf.changed` triggers are the board frames' (frames/board.ts). A frame they send
//   carries no `outcome`: no frozen member reads the stored line outside conversation's
//   transactions (same amendment request).
//
// Nothing here logs: these frames carry message text, custom names and the outcome line (14 §3.5
// SENSITIVE_FRAMES).
import type { HostFrameName } from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { ConversationEvent } from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import {
  CONVERSATION_FRAMES,
  publishConversationFrames,
  type ConversationFramePublisher
} from '../../transport/frames/conversationAppended'
import { toDwarfWire } from '../../transport/mappers/wire'

/**
 * The conversation frames the Host advertises (14 §1.3): `dwarf.changed` is advertised with the
 * board frames.
 */
export const CONVERSATION_READ_FRAMES: readonly HostFrameName[] = Object.freeze([
  ...CONVERSATION_FRAMES,
  'turn.ended'
])

export interface ConversationFrameRouteDeps {
  /** Conversation's events on the Host's bus (16 §2.3). */
  events: Pick<DomainEventBus<ConversationEvent>, 'subscribe'>
  /** Crew's public read of a dwarf, for the `dwarf.changed` of an outcome change. */
  crew: Pick<CrewQueries, 'get'>
  /** Where the frames go: the connection registry. */
  frames: ConversationFramePublisher
}

/** Subscribes the three routes; returns the unsubscribe. */
export function publishConversationReadFrames(deps: ConversationFrameRouteDeps): () => void {
  const { events, frames } = deps
  const unsubscribes = [
    publishConversationFrames({ events, frames }),
    events.subscribe('TurnEnded', ({ payload }) => {
      const { end } = payload
      frames.publishFrame('turn.ended', {
        dwarfId: payload.dwarfId,
        turnKey: end.turnKey,
        kind: end.kind,
        reliability: end.reliability,
        cancelledFromApp: end.cancelledFromApp
      })
    }),
    events.subscribe('OutcomeLineChanged', ({ payload }) => {
      const view = deps.crew.get(payload.dwarfId)
      if (view === null || view.departed) return
      frames.publishFrame('dwarf.changed', {
        dwarf: toDwarfWire(view, { outcome: payload.outcome })
      })
    })
  ]
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
