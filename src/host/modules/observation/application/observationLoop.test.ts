// layer: L2
// L2 (17 §1.2): the observation loop (16 §4.3 `ObservationControl.start/stop/nudge`) over its
// in-memory doubles: `FakeObservationAdapter`, `InMemoryCursorStore`, `InMemoryObservedSessionStore`,
// `RecordingObservedBatchSink`, `RecordingEventBus` (which refuses a publish inside a transaction,
// 16 §2.3), `FakeClock` and `FakeScheduler`. One fake transaction rolls every double back.
//
// TC-070-01, TC-070-02.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { ConversationEntry } from '../../suppliers'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { FakeObservationAdapter } from '../ports/fakes/FakeObservationAdapter'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, ObservedEvent, SourceFile } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent } from './events'
import { OBSERVATION_POLL_MS, ObservationLoop } from './observationLoop'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const S1: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }
const NO_FS = {} as FileSystem

const source = (streamId: string, extra: Partial<SourceFile> = {}): SourceFile => ({
  streamId,
  adapterId: 'simulated',
  path: `/provider/${streamId}.jsonl`,
  fileIdentity: 'file-1',
  size: 1_000,
  ...extra
})

const cursor = (value: number, fileIdentity = 'file-1'): Cursor => ({
  adapterId: 'simulated',
  kind: 'byte-offset',
  value,
  fileIdentity
})

const entry = (key: string, role: ConversationEntry['role'], text: string): ConversationEntry => ({
  sourceKey: `simulated:s1:${key}`,
  role,
  text,
  providerTime: T0
})

/** One session's batch: its start, a person message and a reply, one usage unit, one record. */
function sessionBatch(identity: ProviderIdentity = S1): ObservedEvent[] {
  return [
    { kind: 'session', sourceEventId: 'e1', identity, cwd: MINE, at: T0 },
    {
      kind: 'entries',
      sourceEventId: 'e2',
      identity,
      entries: [entry('e2', 'person', 'Dig the north seam'), entry('e3', 'dwarf', 'Digging.')]
    },
    {
      kind: 'usage',
      sourceEventId: 'e4',
      identity,
      usage: {
        sourceKey: 'simulated:s1:e4',
        unitKey: 'unit-1',
        fidelity: 1,
        tokens: { inputNet: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: T0
      }
    },
    { kind: 'activity', sourceEventId: 'e5', identity, at: T0, activity: 'record' }
  ]
}

function world() {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, sink]) transactions.enlist(participant)
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const adapter = new FakeObservationAdapter('simulated')
  const loop = new ObservationLoop({
    adapters: [adapter],
    fs: NO_FS,
    cursors,
    sessions,
    sink,
    transactions,
    bus,
    clock,
    scheduler,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0070',
    log
  })
  /** One poll: the clock reaches the next cycle and the cycle's reads settle. */
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  const keysOf = (events: ObservationEvent[]) =>
    events.flatMap((e) =>
      e.type === 'TranscriptEntriesObserved'
        ? e.payload.entries.map((x) => x.sourceKey)
        : e.type === 'UsageObserved'
          ? [e.payload.observation.sourceKey]
          : e.type === 'SessionActivityObserved'
            ? [e.payload.sourceKey]
            : []
    )
  return {
    transactions,
    dwarfs,
    cursors,
    sessions,
    sink,
    bus,
    clock,
    log,
    adapter,
    loop,
    poll,
    keysOf
  }
}

describe('ObservationLoop', () => {
  it('[INV-37] a cycle publishes events and writes only cursors and observed-session rows', async () => {
    const w = world()
    const dwarfId = w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source('s1')]
    w.adapter.onRead('s1', () => ({ events: sessionBatch(), next: cursor(120), warnings: [] }))

    w.loop.start()
    await w.loop.whenIdle()

    // The module's own writes: one cursor advance and its observed-session index rows …
    expect(w.cursors.advances).toEqual([{ source: 's1', cursor: cursor(120) }])
    expect(w.sessions.writes).toEqual(['save', 'saveStream'])
    expect(w.sessions.streams(dwarfId)).toEqual([{ dwarfId, streamId: 's1' }])
    // … and the messages and usage go to conversation and ledger through the sink (AMENDMENT-10).
    expect(w.sink.applied).toHaveLength(1)
    expect(w.sink.applied[0]?.dwarfId).toBe(dwarfId)
    expect(w.sink.applied[0]?.entries.map((e) => e.role)).toEqual(['person', 'dwarf'])
    expect(w.sink.applied[0]?.usage.map((u) => [u.unitKey, u.dwarfId])).toEqual([
      ['unit-1', dwarfId]
    ])
    expect(w.transactions.committed).toBe(1)
    // The events left after the commit; a known dwarf is not observed again (S4.31).
    expect(w.bus.published.map((e) => e.type)).toEqual([
      'TranscriptEntriesObserved',
      'UsageObserved',
      'SessionActivityObserved'
    ])
    expect(w.keysOf(w.bus.published)).toEqual([
      'simulated:s1:e2',
      'simulated:s1:e3',
      'simulated:s1:e4',
      'simulated:s1:e5'
    ])
    w.loop.stop()
  })

  it('[INV-38, FM-086] a malformed record is skipped with a warning and the cycle continues', async () => {
    const w = world()
    w.dwarfs.bind(S1, MINE, T0)
    const S2: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-2' }
    w.dwarfs.bind(S2, MINE, T0)
    w.adapter.sources = [source('s0'), source('s1'), source('s2')]
    w.adapter.onRead('s0', () => {
      throw new Error('EACCES: the provider file at a private path is unreadable')
    })
    w.adapter.onRead('s1', () => ({
      events: [{ kind: 'activity', sourceEventId: 'e9', identity: S1, at: T0, activity: 'record' }],
      next: cursor(300),
      warnings: ['line 2: unexpected token']
    }))
    w.adapter.onRead('s2', () => ({
      events: [{ kind: 'activity', sourceEventId: 'e1', identity: S2, at: T0, activity: 'record' }],
      next: cursor(40),
      warnings: []
    }))

    w.loop.start()
    await w.loop.whenIdle()

    // The skipped line and the unreadable stream are drift records, never a throw (INV-38) …
    const drift = w.log.byEvent('observation.drift')
    expect(drift.map((d) => [d.level, d.provider, d.outcome])).toEqual([
      ['warn', 'simulated', 'skipped'],
      ['warn', 'simulated', 'skipped']
    ])
    // … that carry nothing the provider wrote (ADR-026 item 4).
    expect(JSON.stringify(drift)).not.toMatch(/private path|unexpected token/)
    // The other streams of the cycle were read and committed.
    expect(w.cursors.get('s0')).toBeNull()
    expect(w.cursors.get('s1')).toEqual(cursor(300))
    expect(w.cursors.get('s2')).toEqual(cursor(40))
    expect(w.bus.published).toHaveLength(2)
    // And the loop keeps polling.
    await w.poll()
    expect(w.adapter.reads.filter((r) => r.streamId === 's0')).toHaveLength(2)
    w.loop.stop()
  })

  it('[ADR-006] replaying the same records twice publishes the same source keys and advances nothing', async () => {
    const w = world()
    w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source('s1')]
    // Every read from the start answers the same batch, as a re-read file does.
    w.adapter.onRead('s1', () => ({ events: sessionBatch(), next: cursor(120), warnings: [] }))
    // The first batch transaction crashes before its commit (16 §4.3 "Ordering").
    w.sink.failNext(new Error('simulated crash before commit'))

    w.loop.start()
    await w.loop.whenIdle()
    expect(w.bus.published).toEqual([])
    expect(w.cursors.get('s1')).toBeNull()

    // The next cycle re-reads the batch from the old position: published once, cursor moved.
    await w.poll()
    const once = w.keysOf(w.bus.published)
    expect(once).toEqual([
      'simulated:s1:e2',
      'simulated:s1:e3',
      'simulated:s1:e4',
      'simulated:s1:e5'
    ])
    expect(new Set(once).size).toBe(once.length)
    expect(w.cursors.get('s1')).toEqual(cursor(120))

    // A replay of the same records (the adapter answers them again at the same position): the same
    // source keys, which every consumer's idempotent key turns into no new row, and no move.
    const before = w.bus.published.length
    w.adapter.onRead('s1', () => ({ events: sessionBatch(), next: cursor(120), warnings: [] }))
    await w.poll()
    expect(w.keysOf(w.bus.published.slice(before))).toEqual(once)
    expect(w.cursors.get('s1')).toEqual(cursor(120))
    w.loop.stop()
  })

  it('[FM-087] a file that shrinks or is replaced starts a new stream id and never regresses the old cursor', async () => {
    const w = world()
    w.dwarfs.bind(S1, MINE, T0)
    const read = (value: number, identity: string) => () => ({
      events: [],
      next: cursor(value, identity),
      warnings: []
    })
    w.adapter.sources = [source('s1', { size: 1_000 })]
    w.adapter.onRead('s1', read(1_000, 'file-1'))
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.cursors.get('s1')).toEqual(cursor(1_000))

    // The provider rewrote the file shorter: a new stream, read from its start.
    w.adapter.sources = [source('s1', { size: 200 })]
    w.adapter.onRead('s1#1', read(200, 'file-1'))
    await w.poll()
    expect(w.adapter.reads.at(-1)).toEqual({ streamId: 's1#1', from: null })
    expect(w.cursors.get('s1')).toEqual(cursor(1_000))
    expect(w.cursors.get('s1#1')).toEqual(cursor(200))

    // The same stream again is the same generation, read from where it stopped.
    await w.poll()
    expect(w.adapter.reads.at(-1)).toEqual({ streamId: 's1#1', from: cursor(200) })

    // The file was replaced by another one (a new file identity): the next generation.
    w.adapter.sources = [source('s1', { size: 5_000, fileIdentity: 'file-2' })]
    w.adapter.onRead('s1#2', read(5_000, 'file-2'))
    await w.poll()
    expect(w.adapter.reads.at(-1)).toEqual({ streamId: 's1#2', from: null })
    expect(w.cursors.get('s1')).toEqual(cursor(1_000))
    expect(w.cursors.get('s1#1')).toEqual(cursor(200))
    expect(w.cursors.get('s1#2')).toEqual(cursor(5_000, 'file-2'))
    w.loop.stop()
  })

  it('[INV-39] a session with no dwarf yet is observed, and its messages wait for the dwarf with the cursor held', async () => {
    const w = world()
    w.adapter.sources = [source('s1')]
    w.adapter.onRead('s1', () => ({ events: sessionBatch(), next: cursor(120), warnings: [] }))

    w.loop.start()
    await w.loop.whenIdle()
    // No dwarf is bound: the session is announced with its first message, nothing is written.
    expect(w.bus.published.map((e) => e.type)).toEqual(['SessionObserved'])
    expect(w.bus.published[0]?.payload).toEqual({
      identity: S1,
      cwd: MINE,
      firstMessage: true,
      streamId: 's1'
    })
    expect(w.cursors.get('s1')).toBeNull()
    expect(w.sink.applied).toEqual([])

    // The route made the dwarf (crew.arrive): the next cycle writes the batch to it.
    const dwarfId = w.dwarfs.bind(S1, MINE, T0 + 1)
    await w.poll()
    expect(w.sink.applied.map((b) => b.dwarfId)).toEqual([dwarfId])
    expect(w.cursors.get('s1')).toEqual(cursor(120))
    expect(w.bus.ofType('SessionObserved')).toHaveLength(1)
    w.loop.stop()
  })

  it('[INV-39] a session start alone moves only the cursor and is observed without a first message', async () => {
    const w = world()
    w.adapter.sources = [source('s1')]
    w.adapter.onRead('s1', () => ({
      events: [{ kind: 'session', sourceEventId: 'e1', identity: S1, cwd: MINE, at: T0 }],
      next: cursor(40),
      warnings: []
    }))
    w.loop.start()
    await w.loop.whenIdle()
    expect(
      w.bus.published.map((e) => [e.type, (e.payload as { firstMessage?: boolean }).firstMessage])
    ).toEqual([['SessionObserved', false]])
    expect(w.cursors.get('s1')).toEqual(cursor(40))
    expect(w.sessions.writes).toEqual([])
    w.loop.stop()
  })

  it('[INV-37] nudges are coalesced and one cycle runs at a time', async () => {
    const w = world()
    w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source('s1')]
    w.loop.start()
    w.loop.nudge({ providerId: 'simulated' })
    w.loop.nudge({ providerId: 'simulated' })
    w.loop.nudge({ providerId: 'simulated' })
    await w.loop.whenIdle()
    // The start's cycle and one coalesced trailing cycle, never one per nudge.
    expect(w.adapter.reads.map((r) => r.streamId)).toEqual(['s1', 's1'])
    // A nudge on a quiet loop runs a cycle at once.
    w.loop.nudge({ providerId: 'simulated' })
    await w.loop.whenIdle()
    expect(w.adapter.reads).toHaveLength(3)
    // Stopped: no poll and no nudge reads anything.
    w.loop.stop()
    await w.poll()
    w.loop.nudge({ providerId: 'simulated' })
    await w.loop.whenIdle()
    expect(w.adapter.reads).toHaveLength(3)
  })
})
