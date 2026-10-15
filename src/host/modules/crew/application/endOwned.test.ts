// layer: L2
// L2 (17 §1.2): `CrewCommands.endOwned` (16 §4.2; 07 S4.05, S4.07, S15.02, S15.15, S2.15; ADR-014
// items 1, 6, 9; 06 INV-120, INV-121) over the crew's in-memory doubles and a SessionTerminator
// double: every dwarf launching names is asked to stop with `why = 'stop-all'`, the ends run in
// parallel, an ended dwarf departs `stopped`, a failed one stays with its real status, and no event
// of this path is a per-dwarf toast (08 §2.2 `DwarfStopFailed`).
//
// TC-175-01, TC-175-02.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { FakeSessionTerminator } from '../ports/fakes/FakeSessionTerminator'
import type { EndOutcome, EndReason, SessionTerminator } from '../ports/sessionTerminator'
import { CREW_EPOCH, CREW_T0, inMemoryCrew } from '../testing/inMemoryCrew'
import { CrewEndOwned } from './endOwned'
import type { CrewEndEvent } from './events'
import { PendingEndMemory } from './stop'

const MINE = '00000000-0000-7000-8000-0000000175f1' as MineId
const REQUEST = 'stop-all-request-1'

const identity = (session: string): ProviderIdentity => ({
  providerId: 'claude',
  providerSessionId: session
})

/** The crew over its in-memory doubles, with `endOwned` over `terminator`. */
function world(terminator: SessionTerminator = new FakeSessionTerminator()) {
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
  const ends = new CrewEndOwned({
    repository,
    transactions,
    bus,
    clock: crew.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: CREW_EPOCH,
    terminator,
    departures: crew.commands
  })
  const arrive = (session: string, status: 'working' | 'idle' = 'idle') =>
    crew.commands.arrive({ mineId: MINE, identity: identity(session), rank: 'foreman', status })
  return { crew, repository, bus, ends, arrive }
}

/** A terminator whose ends stay pending until the test settles them, one by one. */
class GatedTerminator implements SessionTerminator {
  readonly calls: Array<{ dwarfId: DwarfId; why: EndReason }> = []
  private readonly gates = new Map<DwarfId, (outcome: EndOutcome) => void>()

  end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    this.calls.push({ dwarfId, why })
    return new Promise((resolve) => this.gates.set(dwarfId, resolve))
  }

  endAll(): Promise<Map<DwarfId, EndOutcome>> {
    throw new Error('endOwned ends dwarf by dwarf, never through endAll')
  }

  settle(dwarfId: DwarfId, outcome: EndOutcome): void {
    this.gates.get(dwarfId)?.(outcome)
  }
}

/** Lets the queued promise callbacks run (crew holds no timer, not even in its tests). */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('CrewCommands.endOwned (16 §4.2)', () => {
  it('[S15.02, S4.05, INV-120] every named dwarf is asked to stop with why stop-all and its pending end recorded before its end, and no other dwarf is', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')
    const b = w.arrive('s-b', 'working')
    const observed = w.arrive('s-observed')
    // What launching's required handler sees when it runs: the stop is in flight, no end yet.
    const seen: Array<{ dwarfId: DwarfId; stopInFlight: boolean | undefined; ends: number }> = []
    w.bus.subscribe(
      'DwarfStopRequested',
      ({ payload }) =>
        seen.push({
          dwarfId: payload.dwarfId,
          stopInFlight: w.crew.repository.byId(payload.dwarfId)?.stopInFlight,
          ends: terminator.calls.length
        }),
      { required: true }
    )

    await w.ends.endOwned([a, b], REQUEST)

    expect(w.bus.ofType('DwarfStopRequested').map((event) => event.payload)).toEqual([
      { dwarfId: a, requestId: REQUEST, why: 'stop-all' },
      { dwarfId: b, requestId: REQUEST, why: 'stop-all' }
    ])
    expect(w.bus.ofType('DwarfStopRequested')[0]).toMatchObject({
      v: 1,
      at: CREW_T0,
      hostEpoch: CREW_EPOCH
    })
    expect(seen).toEqual([
      { dwarfId: a, stopInFlight: true, ends: 0 },
      { dwarfId: b, stopInFlight: true, ends: 0 }
    ])
    expect(terminator.calls).toEqual([
      { method: 'end', dwarfId: a, why: 'stop-all' },
      { method: 'end', dwarfId: b, why: 'stop-all' }
    ])
    expect(w.crew.queries.get(observed)).toMatchObject({ departed: false, stopInFlight: false })
    expect(w.bus.handlerErrors).toEqual([])
  })

  it('[S15.02] while its end runs, the dwarf carries the pending end stop-all, so an exit route departs it stopped', async () => {
    const terminator = new GatedTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')

    const running = w.ends.endOwned([a], REQUEST)
    await flush()

    expect(w.repository.pendingEndOf(a)).toBe('stop-all')
    terminator.settle(a, { kind: 'ended' })
    await running
  })

  it('[US-RES-002.AC09, INV-121, S4.06] every ended dwarf departs with cause stopped', async () => {
    const w = world()
    const a = w.arrive('s-a')
    const b = w.arrive('s-b', 'working')

    const result = await w.ends.endOwned([a, b], REQUEST)

    expect(result).toEqual({ ended: [a, b], failed: [] })
    expect(w.crew.bus.ofType('DwarfDeparted').map((event) => event.payload)).toEqual([
      { dwarfId: a, mineId: MINE, cause: 'stopped' },
      { dwarfId: b, mineId: MINE, cause: 'stopped' }
    ])
    expect(w.bus.ofType('DwarfStopFailed')).toEqual([])
  })

  it('[FM-143, S2.15, S4.07] a dwarf that could not be ended stays with its real status and DwarfStopFailed stop-all, while the ended ones depart', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const ended = w.arrive('s-ended')
    const stuck = w.arrive('s-stuck', 'working')
    terminator.script(stuck, { kind: 'failed', reason: 'still-alive' })

    const result = await w.ends.endOwned([ended, stuck], REQUEST)

    expect(result).toEqual({ ended: [ended], failed: [stuck] })
    expect(w.crew.bus.ofType('DwarfDeparted').map((event) => event.payload.dwarfId)).toEqual([
      ended
    ])
    expect(w.bus.ofType('DwarfStopFailed').map((event) => event.payload)).toEqual([
      { dwarfId: stuck, requestId: REQUEST, why: 'stop-all', reason: 'could-not-end' }
    ])
    expect(w.crew.queries.get(stuck)).toMatchObject({
      departed: false,
      status: 'working',
      stopInFlight: false
    })
    expect(w.repository.pendingEndOf(stuck)).toBeNull()
  })

  it('[ADR-014] the ends run in parallel and endOwned answers only after every end settled', async () => {
    const terminator = new GatedTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')
    const b = w.arrive('s-b')
    let answered: { ended: DwarfId[]; failed: DwarfId[] } | null = null

    const running = w.ends.endOwned([a, b], REQUEST).then((result) => (answered = result))
    await flush()
    expect(terminator.calls).toEqual([
      { dwarfId: a, why: 'stop-all' },
      { dwarfId: b, why: 'stop-all' }
    ])
    terminator.settle(b, { kind: 'ended' })
    await flush()
    expect(answered).toBeNull()

    terminator.settle(a, { kind: 'failed', reason: 'access-denied' })
    await running
    expect(answered).toEqual({ ended: [b], failed: [a] })
  })

  it('[ADR-014] a failing required stop handler ends nothing for that dwarf and reports it as failed', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')
    const b = w.arrive('s-b')
    w.bus.subscribe(
      'DwarfStopRequested',
      ({ payload }) => {
        if (payload.dwarfId === b) throw new Error('launch record not writable')
      },
      { required: true }
    )

    const result = await w.ends.endOwned([a, b], REQUEST)

    expect(result).toEqual({ ended: [a], failed: [b] })
    expect(terminator.calls).toEqual([{ method: 'end', dwarfId: a, why: 'stop-all' }])
    expect(w.crew.queries.get(b)).toMatchObject({ departed: false, stopInFlight: false })
  })

  it('[ADR-014] an end that rejects counts as failed and keeps its dwarf', async () => {
    const terminator: SessionTerminator = {
      end: () => Promise.reject(new Error('terminator bridge failed')),
      endAll: () => Promise.reject(new Error('unused'))
    }
    const w = world(terminator)
    const a = w.arrive('s-a')

    expect(await w.ends.endOwned([a], REQUEST)).toEqual({ ended: [], failed: [a] })
    expect(w.crew.queries.get(a)).toMatchObject({ departed: false, stopInFlight: false })
  })

  it('[INV-121] a dwarf that already left is reported ended, with nothing ended or published for it', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const gone = w.arrive('s-gone')
    w.crew.commands.sessionClosed(gone, 'crashed')

    expect(await w.ends.endOwned([gone], REQUEST)).toEqual({ ended: [gone], failed: [] })
    expect(terminator.calls).toEqual([])
    expect(w.bus.published).toEqual([])
  })
})
