// The DomainEventBus conformance suite (16 §2.3, §2.8; 17 §1.3): run against InProcessEventBus
// and RecordingEventBus.
import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '../domain/domainEvent'
import { HostInvariantError } from '../domain/errors'
import type { EventId } from '../domain/values'
import type { DomainEventBus } from '../ports/domainEventBus'
import type { TransactionScope } from '../ports/transactionScope'
import type { HandlerFailure } from '../InProcessEventBus'

/** Two event types of the suite's own; the kernel knows no module's events. */
export type ContractEvent =
  DomainEvent<'ContractAlpha', { n: number }> | DomainEvent<'ContractBeta', { s: string }>

export interface EventBusHooks {
  transactionScope: TransactionScope
  onHandlerError(failure: HandlerFailure): void
}

function alpha(n: number): ContractEvent {
  return {
    type: 'ContractAlpha',
    v: 1,
    id: `event-${n}` as EventId,
    at: 1_000 + n,
    hostEpoch: 'epoch-1',
    payload: { n }
  }
}

export function runEventBusContract(
  makeSubject: (hooks: EventBusHooks) => DomainEventBus<ContractEvent>
): void {
  describe('DomainEventBus contract', () => {
    const setUp = () => {
      const scope = { inTransaction: false, isInTransaction: () => scope.inTransaction }
      const failures: HandlerFailure[] = []
      const bus = makeSubject({
        transactionScope: scope,
        onHandlerError: (failure) => failures.push(failure)
      })
      return { bus, scope, failures }
    }

    it('[ADR-004] handlers run synchronously in subscription order before publish returns', () => {
      const { bus } = setUp()
      const calls: string[] = []
      bus.subscribe('ContractAlpha', (e) => calls.push(`first:${e.payload.n}`))
      bus.subscribe('ContractBeta', () => calls.push('beta'))
      bus.subscribe('ContractAlpha', (e) => calls.push(`second:${e.payload.n}`))
      bus.subscribe('ContractAlpha', (e) => calls.push(`third:${e.payload.n}`))

      bus.publish(alpha(7))

      expect(calls).toEqual(['first:7', 'second:7', 'third:7'])
    })

    it('[ADR-004] a throwing ordinary handler is logged and the remaining handlers still run', () => {
      const { bus, failures } = setUp()
      const calls: string[] = []
      const failure = new Error('handler failed')
      bus.subscribe('ContractAlpha', () => calls.push('before'))
      bus.subscribe('ContractAlpha', () => {
        throw failure
      })
      bus.subscribe('ContractAlpha', () => calls.push('after'))

      expect(() => bus.publish(alpha(1))).not.toThrow()
      expect(calls).toEqual(['before', 'after'])
      expect(failures).toEqual([{ eventType: 'ContractAlpha', error: failure }])
    })

    it('[INV-121] a throwing required handler makes publish throw after every other handler ran', () => {
      const { bus, failures } = setUp()
      const calls: string[] = []
      const failure = new Error('required handler failed')
      bus.subscribe('ContractAlpha', () => calls.push('before'))
      bus.subscribe(
        'ContractAlpha',
        () => {
          throw failure
        },
        { required: true }
      )
      bus.subscribe('ContractAlpha', () => calls.push('after'))

      let thrown: unknown
      try {
        bus.publish(alpha(2))
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(failure)
      expect(calls).toEqual(['before', 'after'])
      expect(failures).toEqual([{ eventType: 'ContractAlpha', error: failure }])
    })

    it('[ADR-004] publish inside a transaction throws HostInvariantError', () => {
      const { bus, scope, failures } = setUp()
      const calls: string[] = []
      bus.subscribe('ContractAlpha', () => calls.push('ran'))

      scope.inTransaction = true
      expect(() => bus.publish(alpha(3))).toThrow(HostInvariantError)
      expect(calls).toEqual([])
      expect(failures).toEqual([])

      scope.inTransaction = false
      bus.publish(alpha(4))
      expect(calls).toEqual(['ran'])
    })

    it('[ADR-004] the unsubscribe function removes exactly that handler', () => {
      const { bus } = setUp()
      const calls: string[] = []
      const shared = (e: ContractEvent) => calls.push(`shared:${e.id}`)
      const unsubscribeFirst = bus.subscribe('ContractAlpha', shared)
      bus.subscribe('ContractAlpha', shared)
      bus.subscribe('ContractAlpha', () => calls.push('other'))

      unsubscribeFirst()
      unsubscribeFirst()
      bus.publish(alpha(5))

      expect(calls).toEqual(['shared:event-5', 'other'])
    })
  })
}
