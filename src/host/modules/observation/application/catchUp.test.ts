// layer: L2
// L2 (17 §1.2): `ObservationControl.catchUp` (16 §4.3; 07 §4B S4.37–S4.39) over the loop's in-memory
// doubles and a scripted `FakeObservationAdapter`. The Host that ran before left its cursors and its
// observed sessions behind; this Host boots and reads every stream from where the last one stopped
// (09 §5.4, ADR-006 item 7), before the live loop starts (16 §8.2 step 7).
import { describe, expect, it } from 'vitest'
import type { DwarfId, FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
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
import type {
  Cursor,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent } from './events'
import { ObservationLoop } from './observationLoop'

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

/** What the provider wrote into the stream, by byte offset: before and while no Host ran. */
const FILE: Array<{ at: number; event: ObservedEvent }> = [
  { at: 0, event: { kind: 'session', sourceEventId: 'e0', identity: S1, cwd: MINE, at: T0 } },
  {
    at: 100,
    event: {
      kind: 'entries',
      sourceEventId: 'e1',
      identity: S1,
      entries: [
        { sourceKey: 'simulated:s1:e1', role: 'person', text: 'Dig east.', providerTime: T0 + 1 }
      ]
    }
  },
  // Written while no Host ran (S4.37).
  {
    at: 200,
    event: {
      kind: 'entries',
      sourceEventId: 'e2',
      identity: S1,
      entries: [
        { sourceKey: 'simulated:s1:e2', role: 'dwarf', text: 'Iron found.', providerTime: T0 + 2 }
      ]
    }
  },
  {
    at: 300,
    event: {
      kind: 'usage',
      sourceEventId: 'e3',
      identity: S1,
      usage: {
        sourceKey: 'simulated:s1:e3',
        unitKey: 'unit-1',
        fidelity: 1,
        tokens: { inputNet: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: T0 + 3
      }
    }
  }
]
const END = 400

/** A provider file: a read from `from` yields every record at or past it, then the end. */
function readFile(extra: Array<{ at: number; event: ObservedEvent }> = []) {
  const file = [...FILE, ...extra]
  const end = Math.max(END, ...extra.map((r) => r.at + 100))
  return (from: Cursor | null) => ({
    events: file.filter((r) => r.at >= (from?.value ?? 0)).map((r) => r.event),
    next: cursor(end),
    warnings: []
  })
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
  adapter.sources = [source]
  const deps = {
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
    hostEpoch: 'epoch-0078',
    log: new RecordingDiagnosticsLog()
  }
  /** A new Host over the same stores (S4.37 → boot). */
  const boot = () => new ObservationLoop(deps)
  /** The Host that ran before: it observed `S1` up to `offset`, then stopped. */
  const observedBefore = (offset: number): DwarfId => {
    const dwarfId = dwarfs.bind(S1, MINE, T0)
    transactions.inTransaction(() => {
      cursors.advance('s1', cursor(offset))
      sessions.saveStream({ dwarfId, streamId: 's1' })
    })
    return dwarfId
  }
  return {
    transactions,
    dwarfs,
    cursors,
    sessions,
    ended,
    sink,
    bus,
    clock,
    adapter,
    deps,
    boot,
    observedBefore
  }
}

const types = (events: readonly ObservationEvent[]) => events.map((e) => e.type)

describe('ObservationControl.catchUp', () => {
  it('[S4.38, INV-98] records written while no Host ran are read from the cursor and published once', async () => {
    const w = world()
    const dwarfId = w.observedBefore(200)
    w.adapter.onRead('s1', readFile())

    // The Host boots: catch-up runs before the live loop starts (16 §8.2 step 7).
    await w.boot().catchUp()

    // Read from the cursor the last Host left, never from the end of the file …
    expect(w.adapter.reads.map((r) => r.from?.value)).toEqual([200])
    // … so the offline reply and its usage are written to the dwarf still there …
    expect(w.sink.applied).toEqual([
      {
        dwarfId,
        entries: [FILE[2]!.event.kind === 'entries' ? FILE[2]!.event.entries[0] : null],
        usage: [expect.objectContaining({ unitKey: 'unit-1', dwarfId, observedAt: T0 })]
      }
    ])
    expect(w.cursors.get('s1')?.value).toBe(END)
    // … and published once, after the commit, without a departure: the session is still alive.
    expect(types(w.bus.published)).toEqual(['TranscriptEntriesObserved', 'UsageObserved'])
    expect(w.sessions.byIdentity(S1)?.closedAt).toBeNull()

    // A second boot with nothing new reads from the advanced cursor and publishes nothing.
    w.bus.published.length = 0
    await w.boot().catchUp()
    expect(w.adapter.reads.map((r) => r.from?.value)).toEqual([200, END])
    expect(w.bus.published).toEqual([])
    expect(w.sink.applied).toHaveLength(1)
  })

  it('[S4.39] a session found ended at catch-up publishes one SessionClosedObserved', async () => {
    const w = world()
    const dwarfId = w.observedBefore(200)
    // While no Host ran the session wrote its reply, then ended; Claude Code writes an ending twice.
    w.adapter.onRead(
      's1',
      readFile([
        { at: 400, event: { kind: 'closed', sourceEventId: 'c1', identity: S1, at: T0 + 10 } },
        { at: 500, event: { kind: 'closed', sourceEventId: 'c2', identity: S1, at: T0 + 11 } }
      ])
    )

    await w.boot().catchUp()

    expect(types(w.bus.published)).toEqual([
      'TranscriptEntriesObserved',
      'UsageObserved',
      'SessionClosedObserved'
    ])
    // Its offline work is written, its ending recorded, and it is closed when it ended.
    expect(w.sink.applied.map((b) => b.dwarfId)).toEqual([dwarfId])
    expect(w.ended.records).toEqual([{ identity: S1, at: T0 + 10 }])
    expect(w.sessions.byIdentity(S1)).toMatchObject({ dwarfId, closedAt: T0 + 10 })

    // The next boot finds nothing new and departs nobody again.
    w.bus.published.length = 0
    await w.boot().catchUp()
    expect(w.bus.published).toEqual([])
  })

  it('[INV-36] an identity in the ended ledger is not resurrected by catch-up', async () => {
    const w = world()
    // DwarfAI ended the session (the terminator's record), its dwarf departed, and the Host stopped.
    const dwarfId = w.observedBefore(200)
    w.boot().recordEnded(S1, T0 + 5)
    w.dwarfs.depart(dwarfId, T0 + 5)
    // A crew route that would make a dwarf for any SessionObserved.
    let arrivals = 0
    w.bus.subscribe('SessionObserved', () => {
      arrivals += 1
    })
    // While no Host ran the provider wrote more into the ended session (a late write).
    w.adapter.onRead('s1', readFile())

    await w.boot().catchUp()

    // Its records move the cursor and nothing else: no arrival, no write, no event (S4.40).
    expect(w.cursors.get('s1')?.value).toBe(END)
    expect(w.bus.published).toEqual([])
    expect(arrivals).toBe(0)
    expect(w.sink.applied).toEqual([])

    // Nor when its dwarf row is gone too: a never-seen ended identity raises no ghost.
    const fresh = world()
    fresh.boot().recordEnded(S1, T0 + 5)
    fresh.adapter.onRead('s1', readFile())
    await fresh.boot().catchUp()
    expect(fresh.cursors.get('s1')?.value).toBe(END)
    expect(fresh.bus.published).toEqual([])
    expect(fresh.sink.applied).toEqual([])
  })
  it('[S4.38] a start while catch-up reads runs its first cycle after the pass, one cycle at a time', async () => {
    const w = world()
    w.observedBefore(200)
    // The stream's read is held open until the test releases it.
    let release!: () => void
    const reading = new Promise<void>((resolve) => (release = resolve))
    const file = readFile()
    let inFlight = 0
    let most = 0
    const slow: ObservationAdapter = {
      providerId: 'simulated',
      cursorKind: 'byte-offset',
      capabilities: () => ({}),
      discover: () => Promise.resolve([source]),
      read: async (_source: SourceFile, from: Cursor | null) => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await reading
        inFlight -= 1
        return file(from)
      }
    }
    const loop = new ObservationLoop({ ...w.deps, adapters: [slow] })

    const catchingUp = loop.catchUp()
    loop.start()
    release()
    await catchingUp
    await loop.whenIdle()
    loop.stop()

    // Two reads, never at once: the pass's from the cursor, then the live cycle's from the end.
    expect(most).toBe(1)
    expect(types(w.bus.published)).toEqual(['TranscriptEntriesObserved', 'UsageObserved'])
    expect(w.sink.applied).toHaveLength(1)
  })
})
