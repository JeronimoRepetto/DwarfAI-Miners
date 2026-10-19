// The production DomainEventBus (16 §2.3, §3): synchronous, in-process fan-out.
//
// - `publish` runs every handler subscribed to the event's type, in subscription order, before it
//   returns; the handlers of one publish are the ones subscribed when it started.
// - A handler that throws is reported through `onHandlerError` (the composition root logs it) and
//   the remaining handlers still run.
// - A handler subscribed with `{ required: true }` that throws makes `publish` rethrow its error
//   after every other handler ran (AR-24: `launching.markStoppedByPerson`, INV-121).
// - `publish` inside a transaction is a programming error: `HostInvariantError` (16 §2.1), and no
//   handler runs.
//
// Generic over the event union so modules add their events without the kernel importing them.
import type { DomainEvent } from './domain/domainEvent'
import { HostInvariantError } from './domain/errors'
import type { DomainEventBus } from './ports/domainEventBus'
import type { TransactionScope } from './ports/transactionScope'

/**
 * What the bus reports when a handler throws. It carries the event type, never the event: payloads
 * may hold custom names and message text, which are never logged (08 §1.2, ADR-026 item 4).
 */
export interface HandlerFailure {
  eventType: string
  error: unknown
}

export interface InProcessEventBusDeps {
  transactionScope: TransactionScope
  onHandlerError: (failure: HandlerFailure) => void
}

interface Subscription<E> {
  handler: (event: E) => void
  required: boolean
}

export class InProcessEventBus<
  E extends DomainEvent<string, unknown>
> implements DomainEventBus<E> {
  private readonly subscriptions = new Map<string, Subscription<E>[]>()
  private readonly transactionScope: TransactionScope
  private readonly onHandlerError: (failure: HandlerFailure) => void

  constructor(deps: InProcessEventBusDeps) {
    this.transactionScope = deps.transactionScope
    this.onHandlerError = deps.onHandlerError
  }

  publish(event: E): void {
    if (this.transactionScope.isInTransaction()) {
      throw new HostInvariantError(
        `DomainEventBus.publish(${event.type}) called inside a transaction; publish after commit (16 §2.3)`
      )
    }
    const handlers = [...(this.subscriptions.get(event.type) ?? [])]
    let requiredFailure: { error: unknown } | null = null
    for (const subscription of handlers) {
      try {
        subscription.handler(event)
      } catch (error) {
        this.onHandlerError({ eventType: event.type, error })
        if (subscription.required && requiredFailure === null) requiredFailure = { error }
      }
    }
    if (requiredFailure !== null) throw requiredFailure.error
  }

  subscribe<K extends E['type']>(
    type: K,
    h: (e: Extract<E, { type: K }>) => void,
    opts?: { required?: boolean }
  ): () => void {
    // The map is keyed by type, so a handler only ever receives events of its own type K.
    const subscription: Subscription<E> = {
      handler: h as (event: E) => void,
      required: opts?.required === true
    }
    const list = this.subscriptions.get(type) ?? []
    list.push(subscription)
    this.subscriptions.set(type, list)
    return () => {
      const current = this.subscriptions.get(type)
      const index = current?.indexOf(subscription) ?? -1
      if (current !== undefined && index !== -1) current.splice(index, 1)
    }
  }
}
