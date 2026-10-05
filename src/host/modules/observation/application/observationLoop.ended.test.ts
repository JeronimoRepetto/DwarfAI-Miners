// layer: L2
// L2 (17 §1.2): the observation loop's anti-ghost half (16 §4.3 `EndedAgentLedger`,
// `ObservationControl.recordEnded`; 07 §4B) over its in-memory doubles, with a scripted
// `FakeObservationAdapter`. The Claude cases over fixtures are `adapters/claude/reconcile.test.ts`.
import { describe, expect, it } from 'vitest'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import { FakeObservationAdapter } from '../ports/fakes/FakeObservationAdapter'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, ObservedEvent, SourceFile } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent } from './events'
import { OBSERVATION_POLL_MS, ObservationLoop } from './observationLoop'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const S1: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }

const source: SourceFile = {
  streamId: 's1',
  adapterId: 'simulated',
  path: '/provider/s1.jsonl',
  fileIdentity: 'file-1',
  size: 1_000
}
const cursor = (value: number): Cursor => ({
  adapterId: 'simulated',
  kind: 'byte-offset',
  value,
  fileIdentity: 'file-1'
})

function records(n: number): ObservedEvent[] {
  return [
    { kind: 'session', sourceEventId: `e${n}`, identity: S1, cwd: MINE, at: T0 },
    {
      kind: 'entries',
      sourceEventId: `e${n + 1}`,
      identity: S1,
      entries: [
        { sourceKey: `simulated:s1:e${n + 1}`, role: 'dwarf', text: 'Digging.', providerTime: T0 }
      ]
    }
  ]
}

function world() {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const ended = new InMemoryEndedAgentLedger(transactions)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, ended, sink]) transactions.enlist(participant)
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const adapter = new FakeObservationAdapter('simulated')
  const loop = new ObservationLoop({
    adapters: [adapter],
    fs: {} as FileSystem,
    cursors,
    sessions,
    ended,
    sink,
    transactions,
    bus,
    clock,
    scheduler: new FakeScheduler(clock),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0072',
    log: new RecordingDiagnosticsLog()
  })
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  return { dwarfs, sessions, ended, sink, bus, clock, adapter, loop, poll }
}

describe('ObservationLoop and the EndedAgentLedger', () => {
  it('[INV-36] a dwarf whose identity was ended while it arrived is closed on its next record, never kept', async () => {
    const w = world()
    w.adapter.sources = [source]
    let next = 1
    w.adapter.onRead('s1', () => {
      const batch = { events: records(next), next: cursor(next * 100), warnings: [] }
      next += 2
      return batch
    })
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.bus.published.map((e) => e.type)).toEqual(['SessionObserved'])

    // The session ends (the terminator's record) while crew's route is still making its dwarf.
    w.loop.recordEnded(S1, T0 + 1)
    const dwarfId = w.dwarfs.bind(S1, MINE, T0 + 2)
    w.bus.published.length = 0
    await w.poll()

    // Its next records close it (S4.33) and write nothing: an active session is never ended.
    expect(w.bus.published.map((e) => e.type)).toEqual(['SessionClosedObserved'])
    expect(w.sink.applied).toEqual([])
    expect(w.sessions.byIdentity(S1)).toMatchObject({ dwarfId, closedAt: T0 + OBSERVATION_POLL_MS })

    // And nothing after that (S4.40).
    w.bus.published.length = 0
    await w.poll()
    expect(w.bus.published).toEqual([])
    expect(w.sink.applied).toEqual([])
    w.loop.stop()
  })

  it('[INV-36] an identity a batch saw end joins the ledger in that batch transaction, once', async () => {
    const w = world()
    const dwarfId = w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source]
    const closed = (n: number): ObservedEvent => ({
      kind: 'closed',
      sourceEventId: `c${n}`,
      identity: S1,
      at: T0 + n
    })
    w.adapter.onRead('s1', () => ({
      events: [...records(1), closed(5), closed(6)],
      next: cursor(100),
      warnings: []
    }))
    w.sink.failNext(new Error('crash inside the batch'))
    w.loop.start()
    await w.loop.whenIdle()
    // Rolled back with its batch: not ended yet, and read again next cycle.
    expect(w.ended.has(S1)).toBe(false)

    await w.poll()
    expect(w.ended.records).toEqual([{ identity: S1, at: T0 + 5 }])
    expect(w.bus.published.filter((e) => e.type === 'SessionClosedObserved')).toHaveLength(1)
    expect(w.sessions.byIdentity(S1)).toMatchObject({ dwarfId, closedAt: T0 + 5 })
    w.loop.stop()
  })
})
