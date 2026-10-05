// layer: L2
// L2 (17 §1.2): the observation loop reports a provider that became unreadable as
// `ProviderErrorObserved` (ISSUE-084; 08 §0, §2.3; 13 FM-067, FM-068; ADR-026 items 4–6), over the
// same in-memory doubles as observationLoop.test.ts. The fold itself is proven in
// domain/providerError.test.ts; here, that the loop feeds it every read and opens it every cycle.
//
// TC-084-01, TC-084-02 (the loop half).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import { DRIFT_SURFACE_THRESHOLD } from '../domain/providerError'
import { FakeObservationAdapter } from '../ports/fakes/FakeObservationAdapter'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, ObservedEvent, SourceFile } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent, ProviderErrorObserved } from './events'
import { OBSERVATION_POLL_MS, ObservationLoop } from './observationLoop'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const S1: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }
const NO_FS = {} as FileSystem

const source = (streamId: string): SourceFile => ({
  streamId,
  adapterId: 'simulated',
  path: `/provider/${streamId}.jsonl`,
  fileIdentity: `file-${streamId}`,
  size: 1_000_000
})

const cursor = (streamId: string, value: number): Cursor => ({
  adapterId: 'simulated',
  kind: 'byte-offset',
  value,
  fileIdentity: `file-${streamId}`
})

/** A record that reads: the session's activity. */
const activity = (id: string): ObservedEvent => ({
  kind: 'activity',
  sourceEventId: id,
  identity: S1,
  at: T0,
  activity: 'record'
})

/**
 * A stream that reads once, then only drifts: every later read skips what the provider wrote in
 * its changed format (a warning carrying provider text), and moves its cursor on.
 */
function readableThenDrifting(streamId: string) {
  return (from: Cursor | null) => {
    const at = from?.value ?? 0
    if (at === 0)
      return { events: [activity(`${streamId}-e1`)], next: cursor(streamId, 100), warnings: [] }
    return {
      events: [],
      next: cursor(streamId, at + 100),
      warnings: ['unreadable line: {"renamed":"the provider wrote this"}']
    }
  }
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
    scheduler: new FakeScheduler(clock),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0084',
    log
  })
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  const errors = () =>
    bus.published.filter((e): e is ProviderErrorObserved => e.type === 'ProviderErrorObserved')
  return { dwarfs, cursors, sessions, bus, log, adapter, loop, poll, errors }
}

describe('ObservationLoop provider errors', () => {
  it('[US-RES-004.AC01, FM-067, FM-068] a dwarf whose streams stop being readable gets one ProviderErrorObserved per cause and poll cycle', async () => {
    const w = world()
    const dwarfId = w.dwarfs.bind(S1, MINE, T0)
    // Two streams of the same dwarf (a transcript and its sidecar), both drifting in every cycle.
    w.adapter.sources = [source('s1'), source('s2')]
    w.adapter.onRead('s1', readableThenDrifting('s1'))
    w.adapter.onRead('s2', readableThenDrifting('s2'))

    w.loop.start()
    await w.loop.whenIdle()
    for (let n = 1; n < DRIFT_SURFACE_THRESHOLD; n++) await w.poll()
    // Below the threshold: drift records only.
    expect(w.errors()).toEqual([])
    expect(w.log.byEvent('observation.drift').length).toBeGreaterThan(0)

    // The cycle that reaches it: one event for the dwarf, though both of its streams crossed.
    await w.poll()
    expect(w.errors().map((e) => e.payload)).toEqual([
      { providerId: 'simulated', cause: 'unreadable', dwarfId }
    ])
    expect(w.errors()[0]).toMatchObject({ v: 1, hostEpoch: 'epoch-0084' })

    // Still unreadable: the person was told; nothing more until it reads again.
    await w.poll()
    await w.poll()
    expect(w.errors()).toHaveLength(1)
    w.loop.stop()
  })

  it('[US-RES-004.AC04, FM-068, INV-38] an adapter read that throws is drift with only its errCode logged and surfaces as the same cause', async () => {
    const w = world()
    const dwarfId = w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source('s1')]
    let reads = 0
    w.adapter.onRead('s1', () => {
      reads += 1
      if (reads === 1) return { events: [activity('e1')], next: cursor('s1', 100), warnings: [] }
      throw Object.assign(new Error('the provider said: database at /home/j/private is locked'), {
        code: 'SQLITE_BUSY'
      })
    })

    w.loop.start()
    await w.loop.whenIdle()
    for (let n = 1; n < DRIFT_SURFACE_THRESHOLD; n++) await w.poll()
    expect(w.errors()).toEqual([])
    await w.poll()
    expect(w.errors().map((e) => e.payload)).toEqual([
      { providerId: 'simulated', cause: 'unreadable', dwarfId }
    ])

    // The log holds the code, never the provider's text (ADR-026 item 4; 16 §2.1).
    const failed = w.log.byEvent('observation.drift').filter((d) => d.causeClass === 'read')
    expect(failed).toHaveLength(DRIFT_SURFACE_THRESHOLD)
    expect(failed.every((d) => d.errCode === 'SQLITE_BUSY')).toBe(true)
    expect(JSON.stringify(w.log.entries)).not.toMatch(/provider said|private/)
    expect(JSON.stringify(w.bus.published)).not.toMatch(/provider said|private|SQLITE_BUSY/)
    // Nothing else moved: the stream's cursor stays where the last readable batch left it.
    expect(w.cursors.get('s1')).toEqual(cursor('s1', 100))
    w.loop.stop()
  })

  it('[US-RES-004.AC04, FM-086, INV-38] skipped lines beside readable records stay drift records and never surface', async () => {
    const w = world()
    w.dwarfs.bind(S1, MINE, T0)
    w.adapter.sources = [source('s1')]
    w.adapter.onRead('s1', (from) => {
      const at = from?.value ?? 0
      return {
        events: [activity(`e${at}`)],
        next: cursor('s1', at + 100),
        warnings: ['unreadable line']
      }
    })

    w.loop.start()
    await w.loop.whenIdle()
    for (let n = 0; n < DRIFT_SURFACE_THRESHOLD * 2; n++) await w.poll()
    expect(w.errors()).toEqual([])
    expect(w.log.byEvent('observation.drift')).toHaveLength(DRIFT_SURFACE_THRESHOLD * 2 + 1)
    w.loop.stop()
  })
})
