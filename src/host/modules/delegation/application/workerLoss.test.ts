// layer: L2
// The worker loss (07 S8.09; 06 INV-84; 16 §5.5 "Host restart"; ISSUE-209): a `running` delegation
// whose worker's session ended without a result, or whose worker did not survive a Host restart,
// settles `failed{worker-lost}`: committed first, then `DelegationFailed` published and the waiting
// `subtask_result` calls woken. Over the in-memory ticket store, a fake clock and a recording bus.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, HostEpoch, Instant } from '../../../kernel/domain/values'
import type { Delegation, DelegationId } from '../domain/delegation'
import type { DelegationFailed } from '../domain/events'
import type { SubtaskText } from '../domain/subtaskText'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import { DelegationWorkerLoss } from './workerLoss'

const T0: Instant = 1_750_000_000_000
const PARENT = '00000000-0000-7000-8000-0000000c2091' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000c2092' as DwarfId
const OTHER_WORKER = '00000000-0000-7000-8000-0000000c2093' as DwarfId

function delegation(id: string, change: Partial<Delegation>): Delegation {
  return {
    id: id as DelegationId,
    parentDwarfId: PARENT,
    ticket: `ticket-${id}`,
    task: 'Map the old shafts' as SubtaskText,
    state: 'running',
    workerDwarfId: WORKER,
    createdAt: T0,
    ...change
  }
}

function setUp(rows: readonly Delegation[]) {
  const clock = new FakeClock(T0)
  const tickets = new InMemoryDelegationTicketStore()
  for (const row of rows) tickets.put(row)
  const bus = new RecordingEventBus<DelegationFailed>()
  const woken: string[] = []
  const loss = new DelegationWorkerLoss({
    tickets,
    transactions: { inTransaction: (work) => work() },
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-209' as HostEpoch,
    settled: (ticket) => woken.push(ticket)
  })
  return { clock, tickets, bus, woken, loss }
}

describe('the worker loss (S8.09, INV-84; ISSUE-209)', () => {
  it("[S8.09] a running delegation whose worker's session ended fails worker-lost, once, with its parent's event", () => {
    const s = setUp([delegation('d-1', {})])
    s.clock.advance(5_000)

    expect(s.loss.workerLost(WORKER)).toBe(true)
    expect(s.loss.workerLost(WORKER)).toBe(false)

    expect(s.tickets.byTicket('ticket-d-1')).toMatchObject({
      state: 'failed',
      failure: 'worker-lost',
      settledAt: T0 + 5_000
    })
    expect(s.tickets.byTicket('ticket-d-1')).not.toHaveProperty('task')
    expect(s.bus.ofType('DelegationFailed').map((e) => e.payload)).toStrictEqual([
      { delegationId: 'd-1', parentDwarfId: PARENT, failure: 'worker-lost' }
    ])
    expect(s.woken).toStrictEqual(['ticket-d-1'])
  })

  it('[S8.09, S8.08] a worker that leaves after its delegation succeeded, or a dwarf that is no worker, changes nothing', () => {
    const s = setUp([
      delegation('d-2', {
        state: 'succeeded',
        handoff: { via: 'tool-result', phase: 'delivered', phaseAt: T0 },
        settledAt: T0,
        task: undefined
      })
    ])

    expect(s.loss.workerLost(WORKER)).toBe(false)
    expect(s.loss.workerLost(OTHER_WORKER)).toBe(false)
    expect(s.tickets.byTicket('ticket-d-2')).toMatchObject({ state: 'succeeded' })
    expect(s.bus.ofType('DelegationFailed')).toStrictEqual([])
  })

  it('[INV-84] the boot reconcile fails every running delegation whose worker did not survive and keeps the others', () => {
    const s = setUp([
      delegation('d-3', { workerDwarfId: WORKER }),
      delegation('d-4', { workerDwarfId: OTHER_WORKER }),
      delegation('d-5', { state: 'attempted', workerDwarfId: undefined })
    ])

    const failed = s.loss.reconcileOnBoot((worker) => worker === OTHER_WORKER)

    expect(failed).toBe(1)
    expect(s.tickets.byTicket('ticket-d-3')).toMatchObject({
      state: 'failed',
      failure: 'worker-lost'
    })
    expect(s.tickets.byTicket('ticket-d-4')).toMatchObject({ state: 'running' })
    // An `attempted` one is the routing reconcile's (S8.12), never this one's.
    expect(s.tickets.byTicket('ticket-d-5')).toMatchObject({ state: 'attempted' })
    expect(s.bus.ofType('DelegationFailed').map((e) => e.payload.delegationId)).toStrictEqual([
      'd-3'
    ])
  })
})
