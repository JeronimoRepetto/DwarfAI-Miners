// Kernel driven port (05 §3, 16 §3; semantics 16 §2.3). A throwing `required` handler makes
// publish throw after the other handlers ran.
//
// `E` is the event union a composition binds; the kernel knows no module's events (R1, R4), so
// the 05 §3 `DomainEvent` of the signature is this parameter.
import type { DomainEvent } from '../domain/domainEvent'

export interface DomainEventBus<
  E extends DomainEvent<string, unknown> = DomainEvent<string, unknown>
> {
  publish(event: E): void
  subscribe<K extends E['type']>(
    type: K,
    h: (e: Extract<E, { type: K }>) => void,
    opts?: { required?: boolean }
  ): () => void
}
