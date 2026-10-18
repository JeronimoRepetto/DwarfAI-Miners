// layer: L2
// L2 (17 §1.2): `CrewCommands.endDelegated` (16 §4.2 row `endDelegated`; 07 S8.08, S15.02; ADR-014
// item 10; AMENDMENT-2, SC-AR-02; PO #17) over the crew's in-memory doubles and a SessionTerminator
// double: the worker whose result reached its parent is asked to stop with `why =
// 'delegation-done'` (so launching marks `stopped_by_person` first), ended, and departs `stopped`;
// a failed end keeps it present, logged, with no toast-raising event.
//
// TC-205-03.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { FakeSessionTerminator } from '../ports/fakes/FakeSessionTerminator'
import { CREW_EPOCH, inMemoryCrew } from '../testing/inMemoryCrew'
import { CrewEndDelegated } from './endDelegated'
import type { CrewEndEvent } from './events'
import { PendingEndMemory } from './stop'

const MINE = '00000000-0000-7000-8000-0000000205f1' as MineId
const DELEGATION = '00000000-0000-7000-8000-0000000205d1'

const identity = (session: string): ProviderIdentity => ({
  providerId: 'claude',
  providerSessionId: session
})

function world(terminator = new FakeSessionTerminator()) {
  const crew = inMemoryCrew()
  // As createCrew decorates its repository: the pending `why` is Host memory beside the rows.
  const repository = new PendingEndMemory(crew.repository)
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      const outer = open
      open = true
      try {
        return crew.transactionRunner.inTransaction(work)
      } finally {
        open = outer
      }
    }
  }
  const bus = new RecordingEventBus<CrewEndEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const log = new RecordingDiagnosticsLog()
  const ends = new CrewEndDelegated({
    repository,
    transactions,
    bus,
    clock: crew.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: CREW_EPOCH,
    terminator,
    departures: crew.commands,
    log
  })
  const parent = crew.commands.arrive({
    mineId: MINE,
    identity: identity('parent-205'),
    rank: 'foreman',
    status: 'working'
  })
  const worker = crew.commands.arrive({
    mineId: MINE,
    identity: identity('worker-205'),
    parent,
    rank: 'worker',
    status: 'idle',
    delegated: true
  })
  return { crew, repository, bus, log, ends, terminator, parent, worker }
}

describe('CrewCommands.endDelegated (16 §4.2)', () => {
  it('[US-DLG-004.AC03, S8.08] the worker is asked to stop first, ended with delegation-done and departs as stopped', async () => {
    const w = world()
    // What launching's required handler sees: the stop in flight, no end yet.
    const seen: Array<{ dwarfId: DwarfId; ends: number; pendingEnd: string | null }> = []
    w.bus.subscribe(
      'DwarfStopRequested',
      ({ payload }) =>
        seen.push({
          dwarfId: payload.dwarfId,
          ends: w.terminator.calls.length,
          pendingEnd: w.repository.pendingEndOf(payload.dwarfId)
        }),
      { required: true }
    )

    const outcome = await w.ends.endDelegated(w.worker, DELEGATION)

    expect(outcome).toStrictEqual({ kind: 'ended' })
    expect(w.bus.ofType('DwarfStopRequested').map((e) => e.payload)).toStrictEqual([
      { dwarfId: w.worker, requestId: DELEGATION, why: 'delegation-done' }
    ])
    expect(seen).toStrictEqual([{ dwarfId: w.worker, ends: 0, pendingEnd: 'delegation-done' }])
    expect(w.terminator.calls).toStrictEqual([
      { method: 'end', dwarfId: w.worker, why: 'delegation-done' }
    ])
    expect(w.crew.bus.ofType('DwarfDeparted').map((e) => e.payload)).toStrictEqual([
      { dwarfId: w.worker, mineId: MINE, cause: 'stopped' }
    ])
    expect(w.bus.ofType('DwarfStopFailed')).toStrictEqual([])
    expect(w.crew.queries.get(w.parent)).toMatchObject({ departed: false })
  })

  it('[US-DLG-004.AC03, S8.08] a failed end keeps the worker present, logged, and raises no toast', async () => {
    const w = world()
    w.terminator.script(w.worker, { kind: 'failed', reason: 'protocol-error' })

    const outcome = await w.ends.endDelegated(w.worker, DELEGATION)

    expect(outcome).toStrictEqual({ kind: 'failed', reason: 'protocol-error' })
    expect(w.crew.queries.get(w.worker)).toMatchObject({ departed: false, stopInFlight: false })
    expect(w.repository.pendingEndOf(w.worker)).toBeNull()
    expect(w.crew.bus.ofType('DwarfDeparted')).toStrictEqual([])
    // The one toast of a failed end is `why: 'stop-dwarf'`'s (routes/launching.ts `routeStops`).
    expect(w.bus.ofType('DwarfStopFailed').map((e) => e.payload)).toStrictEqual([
      {
        dwarfId: w.worker,
        requestId: DELEGATION,
        why: 'delegation-done',
        reason: 'could-not-end'
      }
    ])
    expect(w.log.byEvent('crew.delegated-end.failed')).toHaveLength(1)
    expect(JSON.stringify(w.log.entries)).not.toContain('worker-205')
  })

  it('[US-DLG-004.AC03] when the stop request cannot be recorded first, the worker is not ended', async () => {
    const w = world()
    w.bus.subscribe(
      'DwarfStopRequested',
      () => {
        throw new Error('launching could not mark stopped_by_person')
      },
      { required: true }
    )

    const outcome = await w.ends.endDelegated(w.worker, DELEGATION)

    expect(outcome.kind).toBe('failed')
    expect(w.terminator.calls).toStrictEqual([])
    expect(w.crew.queries.get(w.worker)).toMatchObject({ departed: false, stopInFlight: false })
  })

  it('[INV-28] a dwarf that is not a present delegated worker is not ended and the call answers ended', async () => {
    const w = world()
    w.crew.commands.sessionClosed(w.worker, 'stopped')

    expect(await w.ends.endDelegated(w.parent, DELEGATION)).toStrictEqual({ kind: 'ended' })
    expect(await w.ends.endDelegated(w.worker, DELEGATION)).toStrictEqual({ kind: 'ended' })

    expect(w.terminator.calls).toStrictEqual([])
    expect(w.bus.published).toStrictEqual([])
    expect(w.crew.queries.get(w.parent)).toMatchObject({ departed: false })
  })
})
