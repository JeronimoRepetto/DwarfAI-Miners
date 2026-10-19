// layer: L2
// L2 (17 §1.2): `CrewCommands.endAllIn` (16 §4.2; 07 S4.05, S4.07, S15.02, S15.15, S2.05, S2.15;
// ADR-014 items 1, 6) over the crew's in-memory doubles and a SessionTerminator double: every present
// dwarf of the mine is asked to stop with `why = 'remove-mine'`, the ends run in parallel, an ended
// dwarf departs `mine-removed`, a failed one stays with its real status, and no event of this path
// is a per-dwarf toast (08 §2.2 `DwarfStopFailed`).
//
// TC-080-01, TC-080-02.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { FakeSessionTerminator } from '../ports/fakes/FakeSessionTerminator'
import type { EndOutcome, EndReason, SessionTerminator } from '../ports/sessionTerminator'
import { CREW_EPOCH, CREW_T0, inMemoryCrew } from '../testing/inMemoryCrew'
import { CrewEndAllIn } from './endAllIn'
import type { CrewEndEvent } from './events'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const OTHER_MINE = '00000000-0000-7000-8000-0000000000f2' as MineId
const REQUEST = 'remove-request-1'

const identity = (session: string): ProviderIdentity => ({
  providerId: 'claude',
  providerSessionId: session
})

/** The crew over its in-memory doubles, with `endAllIn` over `terminator`. */
function world(terminator: SessionTerminator = new FakeSessionTerminator()) {
  const crew = inMemoryCrew()
  // The end events go to the bus wiring hands `Crew.ends` (the departures to crew's own); like
  // crew's, it refuses a publish inside the command's transaction (16 §2.3).
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
  const ends = new CrewEndAllIn({
    repository: crew.repository,
    transactions,
    bus,
    clock: crew.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: CREW_EPOCH,
    terminator,
    departures: crew.commands
  })
  const arrive = (session: string, mineId: MineId = MINE, status: 'working' | 'idle' = 'idle') =>
    crew.commands.arrive({ mineId, identity: identity(session), rank: 'foreman', status })
  return { crew, bus, ends, arrive }
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
    throw new Error('endAllIn ends dwarf by dwarf, never through endAll')
  }

  settle(dwarfId: DwarfId, outcome: EndOutcome): void {
    this.gates.get(dwarfId)?.(outcome)
  }
}

/** Lets the queued promise callbacks run (crew holds no timer, not even in its tests). */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('CrewCommands.endAllIn (16 §4.2)', () => {
  it('[S15.02, S4.05] every present dwarf of the mine is asked to stop with why remove-mine before its end, and no other dwarf is', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')
    const b = w.arrive('s-b', MINE, 'working')
    const gone = w.arrive('s-gone')
    w.crew.commands.sessionClosed(gone, 'closed-elsewhere')
    const elsewhere = w.arrive('s-elsewhere', OTHER_MINE)
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

    await w.ends.endAllIn(MINE, REQUEST)

    expect(w.bus.ofType('DwarfStopRequested').map((event) => event.payload)).toEqual([
      { dwarfId: a, requestId: REQUEST, why: 'remove-mine' },
      { dwarfId: b, requestId: REQUEST, why: 'remove-mine' }
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
      { method: 'end', dwarfId: a, why: 'remove-mine' },
      { method: 'end', dwarfId: b, why: 'remove-mine' }
    ])
    expect(w.crew.queries.get(elsewhere)?.departed).toBe(false)
    expect(w.bus.handlerErrors).toEqual([])
  })

  it('[US-OBS-005.AC05, S2.05] every dwarf of the removed mine departs with cause mine-removed, so its panel closes', async () => {
    const w = world()
    const a = w.arrive('s-a')
    const b = w.arrive('s-b', MINE, 'working')

    const result = await w.ends.endAllIn(MINE, REQUEST)

    expect(result).toEqual({ ended: [a, b], failed: [] })
    expect(w.crew.bus.ofType('DwarfDeparted').map((event) => event.payload)).toEqual([
      { dwarfId: a, mineId: MINE, cause: 'mine-removed' },
      { dwarfId: b, mineId: MINE, cause: 'mine-removed' }
    ])
    expect(w.crew.queries.crewOf(MINE)).toEqual([])
    expect(w.bus.ofType('DwarfStopFailed')).toEqual([])
  })

  it('[US-MINES-006.AC09, S2.15, S15.15] a dwarf that could not be ended stays with its real status and DwarfStopFailed remove-mine, while the ended ones depart', async () => {
    const terminator = new FakeSessionTerminator()
    const w = world(terminator)
    const ended = w.arrive('s-ended')
    const stuck = w.arrive('s-stuck', MINE, 'working')
    terminator.script(stuck, { kind: 'failed', reason: 'no-identity' })

    const result = await w.ends.endAllIn(MINE, REQUEST)

    expect(result).toEqual({ ended: [ended], failed: [stuck] })
    expect(w.crew.bus.ofType('DwarfDeparted').map((event) => event.payload.dwarfId)).toEqual([
      ended
    ])
    expect(w.bus.ofType('DwarfStopFailed').map((event) => event.payload)).toEqual([
      { dwarfId: stuck, requestId: REQUEST, why: 'remove-mine', reason: 'could-not-end' }
    ])
    const left = w.crew.queries.get(stuck)
    expect(left).toMatchObject({ departed: false, status: 'working', stopInFlight: false })
    expect(left?.stopUnavailableReason).toBeNull()
    expect(w.crew.queries.crewOf(MINE).map((dwarf) => dwarf.id)).toEqual([stuck])
  })

  it('[ADR-014] the ends run in parallel and endAllIn answers only after every end settled', async () => {
    const terminator = new GatedTerminator()
    const w = world(terminator)
    const a = w.arrive('s-a')
    const b = w.arrive('s-b')
    let answered: { ended: DwarfId[]; failed: DwarfId[] } | null = null

    const running = w.ends.endAllIn(MINE, REQUEST).then((result) => (answered = result))
    await flush()
    // Both ends were started before either settled.
    expect(terminator.calls).toEqual([
      { dwarfId: a, why: 'remove-mine' },
      { dwarfId: b, why: 'remove-mine' }
    ])
    terminator.settle(b, { kind: 'ended' })
    await flush()
    expect(answered).toBeNull()

    terminator.settle(a, { kind: 'failed', reason: 'still-alive' })
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

    const result = await w.ends.endAllIn(MINE, REQUEST)

    expect(result).toEqual({ ended: [a], failed: [b] })
    expect(terminator.calls).toEqual([{ method: 'end', dwarfId: a, why: 'remove-mine' }])
    expect(w.bus.ofType('DwarfStopFailed').map((event) => event.payload.dwarfId)).toEqual([b])
    expect(w.crew.queries.get(b)).toMatchObject({ departed: false, stopInFlight: false })
  })

  it('[ADR-014] an end that rejects counts as failed and keeps its dwarf', async () => {
    const terminator: SessionTerminator = {
      end: () => Promise.reject(new Error('terminator bridge failed')),
      endAll: () => Promise.reject(new Error('unused'))
    }
    const w = world(terminator)
    const a = w.arrive('s-a')

    expect(await w.ends.endAllIn(MINE, REQUEST)).toEqual({ ended: [], failed: [a] })
    expect(w.crew.queries.get(a)).toMatchObject({ departed: false, stopInFlight: false })
  })
})
