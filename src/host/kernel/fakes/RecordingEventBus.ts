// The recording DomainEventBus double (16 §2.8, §3): captures every accepted event and also
// dispatches to subscribers with the real semantics, so it passes runEventBusContract. It
// dispatches through an InProcessEventBus, which keeps the double from drifting from the adapter.
import type { DomainEvent } from '../domain/domainEvent'
import { HostInvariantError } from '../domain/errors'
import {
  InProcessEventBus,
  type HandlerFailure,
  type InProcessEventBusDeps
} from '../InProcessEventBus'
import type { DomainEventBus } from '../ports/domainEventBus'
import type { TransactionScope } from '../ports/transactionScope'

const NEVER_IN_TRANSACTION: TransactionScope = { isInTransaction: () => false }

export class RecordingEventBus<
  E extends DomainEvent<string, unknown>
> implements DomainEventBus<E> {
  /** Every event `publish` accepted, in publish order (a refused in-transaction publish is not). */
  readonly published: E[] = []
  /** Handler failures, when no `onHandlerError` was given. */
  readonly handlerErrors: HandlerFailure[] = []
  private readonly transactionScope: TransactionScope
  private readonly inner: InProcessEventBus<E>

  /** Both deps are optional: by default it is never in a transaction and keeps failures here. */
  constructor(deps: Partial<InProcessEventBusDeps> = {}) {
    this.transactionScope = deps.transactionScope ?? NEVER_IN_TRANSACTION
    this.inner = new InProcessEventBus<E>({
      transactionScope: NEVER_IN_TRANSACTION,
      onHandlerError: deps.onHandlerError ?? ((failure) => this.handlerErrors.push(failure))
    })
  }

  publish(event: E): void {
    if (this.transactionScope.isInTransaction()) {
      throw new HostInvariantError(
        `DomainEventBus.publish(${event.type}) called inside a transaction; publish after commit (16 §2.3)`
      )
    }
    this.published.push(event)
    this.inner.publish(event)
  }

  subscribe<K extends E['type']>(
    type: K,
    h: (e: Extract<E, { type: K }>) => void,
    opts?: { required?: boolean }
  ): () => void {
    return this.inner.subscribe(type, h, opts)
  }

  /** The published events of one type, in publish order. */
  ofType<K extends E['type']>(type: K): Extract<E, { type: K }>[] {
    return this.published.filter((event): event is Extract<E, { type: K }> => event.type === type)
  }
}
