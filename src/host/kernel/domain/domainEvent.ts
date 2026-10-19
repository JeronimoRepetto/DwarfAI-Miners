// The domain event envelope (08 §1.2). Modules declare their own event unions over it; the
// kernel never imports them (R1, R4).
import type { EventId, HostEpoch, Instant } from './values'

export interface DomainEvent<T extends string, P> {
  type: T
  /** Payload version of this event type (08 §6). */
  v: 1
  id: EventId
  /** Host clock at publish (`Clock` port), not the provider time. */
  at: Instant
  /** The boot that produced it (ADR-015). */
  hostEpoch: HostEpoch
  /** The event or command that caused it (diagnostics only). */
  causationId?: EventId
  payload: P
}
