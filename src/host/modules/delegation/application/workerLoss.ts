// The worker loss (07 S8.09; 06 INV-84; 16 §5.5 "Window closed / Host restart"; ISSUE-209): a
// `running` delegation whose worker is gone without a result settles `failed{worker-lost}`.
//
// - `workerLost(worker)`: the route of the worker's `DwarfDeparted` (S8.09: its session ended).
//   Only a `running` delegation of that worker moves; one already settled (the worker walks out
//   after its handoff, S8.08; or its parent left, S8.11) refuses the event, so nothing changes.
// - `reconcileOnBoot(survived)`: boot, once the Host recovery classified (16 §8.2 step 5): every
//   `running` delegation whose worker `survived` does not hold fails `worker-lost` (INV-84). An
//   `attempted` one is the routing reconcile's (`SubtaskRunService.failRoutingOnBoot`, S8.12).
//
// Each settlement re-reads the delegation inside its transaction and applies the 07 §8 event to
// what is stored now (16 §2.2). `DelegationFailed` goes out after the commit (16 §2.3), so the
// parent's one line follows through its route (US-DLG-005; the route skips a parent that is gone),
// then `settled(ticket)` wakes the `subtask_result` calls waiting on the ticket, which now answer
// the failure and the parent's native-subagent fallback.
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyEvent, type Delegation } from '../domain/delegation'
import type { DelegationFailed } from '../domain/events'
import type { DelegationTicketStore } from '../ports/delegationStores'

export interface WorkerLossDeps {
  tickets: DelegationTicketStore
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: Pick<DomainEventBus<DelegationFailed>, 'publish'>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /** Wakes the `result` calls waiting on a ticket whose delegation changed state. */
  settled?: (ticket: string) => void
}

export class DelegationWorkerLoss {
  constructor(private readonly deps: WorkerLossDeps) {}

  /** S8.09: the worker's session ended; answers whether a delegation failed. */
  workerLost(worker: DwarfId): boolean {
    return this.fail((d) => d.workerDwarfId === worker) > 0
  }

  /** INV-84: the running delegations whose worker did not survive; answers how many failed. */
  reconcileOnBoot(survived: (worker: DwarfId) => boolean): number {
    return this.fail((d) => d.workerDwarfId === undefined || !survived(d.workerDwarfId))
  }

  private fail(lost: (delegation: Delegation) => boolean): number {
    const { transactions, tickets, clock } = this.deps
    const failed = transactions.inTransaction(() => {
      const at = clock.now()
      const settled: Delegation[] = []
      for (const delegation of tickets.inFlight()) {
        if (delegation.state !== 'running' || !lost(delegation)) continue
        const moved = applyEvent(delegation, { type: 'worker-lost' }, at)
        if (!moved.ok) continue
        tickets.save(moved.value.delegation)
        settled.push(moved.value.delegation)
      }
      return settled
    })
    for (const delegation of failed) {
      this.deps.bus.publish(this.failedEvent(delegation))
      this.deps.settled?.(delegation.ticket)
    }
    return failed.length
  }

  private failedEvent(delegation: Delegation): DelegationFailed {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type: 'DelegationFailed',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: {
        delegationId: delegation.id,
        parentDwarfId: delegation.parentDwarfId,
        failure: 'worker-lost'
      }
    }
  }
}
