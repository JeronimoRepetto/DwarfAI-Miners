// layer: L10
// L10 (17 §1.10; 13 FM-097, and FM-086 / FM-137 on the way): activity and endings written while no
// Host ran, then boots that fail part-way. The previous Host left cursors, observed sessions and an
// ended ledger; while no Host ran (S4.37) the provider kept writing. The faults are scripted on
// fake-level injectors (17 §1.10 "fake in L2 and L3"): a stream whose read fails once (drift,
// INV-38), a batch whose write fails inside its transaction (rolled back whole), and a Host that
// dies while it reads a stream (its catch-up never returns; the next boot starts over the same
// stores). Deterministic: a fake clock and scheduler, scripted faults, no disk, no timer.
import { describe, expect, it } from 'vitest'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
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
import { OBSERVATION_POLL_MS, ObservationLoop } from './observationLoop'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const PROVIDER = 'simulated'
const identity = (session: string): ProviderIdentity => ({
  providerId: PROVIDER,
  providerSessionId: session
})

/**
 * Provider files with a watermark cursor (the count of records read), and the chaos injectors: a
 * read of a stream that fails once, and a stream whose read never returns (the Host dies there).
 */
class ChaosFiles implements ObservationAdapter {
  readonly providerId = PROVIDER
  readonly cursorKind = 'watermark' as const
  readonly files = new Map<string, ObservedEvent[]>()
  readonly failOnce = new Set<string>()
  hangAt: string | null = null
  /** Called when a read reaches `hangAt`: everything before it in the pass has run. */
  onHang: () => void = () => undefined

  capabilities(): ReturnType<ObservationAdapter['capabilities']> {
    return { observe: true }
  }

  write(session: string, ...records: Array<(id: string) => ObservedEvent>): void {
    const file = this.files.get(session) ?? []
    for (const record of records) file.push(record(`${session}-r${file.length}`))
    this.files.set(session, file)
  }

  discover(_fs: FileSystem): Promise<SourceFile[]> {
    return Promise.resolve(
      [...this.files].map(([session, file]) => ({
        streamId: session,
        adapterId: PROVIDER,
        path: session,
        fileIdentity: session,
        size: file.length
      }))
    )
  }

  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    if (this.hangAt === source.streamId) {
      this.onHang()
      return new Promise(() => undefined)
    }
    if (this.failOnce.delete(source.streamId)) {
      return Promise.reject(new Error('EBUSY: the provider holds the file'))
    }
    const file = this.files.get(source.path) ?? []
    return Promise.resolve({
      events: file.slice(from?.value ?? 0),
      next: {
        adapterId: PROVIDER,
        kind: 'watermark',
        value: file.length,
        fileIdentity: source.path
      },
      warnings: []
    })
  }
}

const started =
  (session: string) =>
  (id: string): ObservedEvent => ({
    kind: 'session',
    sourceEventId: id,
    identity: identity(session),
    cwd: MINE,
    at: T0
  })
const said =
  (session: string, text: string) =>
  (id: string): ObservedEvent => ({
    kind: 'entries',
    sourceEventId: id,
    identity: identity(session),
    entries: [{ sourceKey: `${PROVIDER}:${id}`, role: 'dwarf', text, providerTime: T0 + 1 }]
  })
const spent =
  (session: string, unitKey: string) =>
  (id: string): ObservedEvent => ({
    kind: 'usage',
    sourceEventId: id,
    identity: identity(session),
    usage: {
      sourceKey: `${PROVIDER}:${id}`,
      unitKey,
      fidelity: 1,
      tokens: { inputNet: 10_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      sealed: true,
      providerTime: T0 + 2
    }
  })
const ended =
  (session: string, at: number) =>
  (id: string): ObservedEvent => ({
    kind: 'closed',
    sourceEventId: id,
    identity: identity(session),
    at
  })

function world() {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const ledger = new InMemoryEndedAgentLedger(transactions)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, ledger, sink]) transactions.enlist(participant)
  // Refuses a publish inside a transaction (16 §2.3): every event seen here followed a commit.
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  // Crew's routes, played: an observed session's dwarf arrives, a closed one departs.
  bus.subscribe('SessionObserved', ({ payload }) => void dwarfs.bind(payload.identity, MINE, T0))
  bus.subscribe('SessionClosedObserved', ({ payload, at }) => {
    const dwarf = dwarfs.bound(payload.identity)
    if (dwarf !== null) dwarfs.depart(dwarf.dwarfId, at)
  })
  const clock = new FakeClock(T0)
  const files = new ChaosFiles()
  const log = new RecordingDiagnosticsLog()
  const boot = () =>
    new ObservationLoop({
      adapters: [files],
      fs: {} as FileSystem,
      cursors,
      sessions,
      ended: ledger,
      sink,
      transactions,
      bus,
      clock,
      scheduler: new FakeScheduler(clock),
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0078',
      log
    })
  return { transactions, dwarfs, cursors, sessions, ledger, sink, bus, clock, files, log, boot }
}

describe('catch-up under faults (FM-097)', () => {
  it('[FM-097] a Host started after offline activity credits what its known sessions spent once, departs the ended ones, admits no session that ended unseen, and a second boot adds nothing', async () => {
    const w = world()

    // The Host that ran before observed s1, s2 and s3, and DwarfAI ended s3 before it quit.
    for (const session of ['s1', 's2', 's3']) w.files.write(session, started(session))
    const before = w.boot()
    before.start()
    await before.whenIdle()
    before.recordEnded(identity('s3'), T0 + 5)
    w.dwarfs.depart(w.dwarfs.bound(identity('s3'))!.dwarfId, T0 + 5)
    before.stop()
    expect(w.dwarfs.bound(identity('s1'))?.departedAt).toBeNull()
    const beforeEvents = w.bus.published.length

    // While no Host ran (S4.37): s1 kept working, s2 worked and ended, s3 wrote late records, and
    // s4 started, worked and ended.
    w.clock.advance(3_600_000)
    w.files.write('s1', said('s1', 'Iron.'), spent('s1', 'u1'), spent('s1', 'u2'))
    w.files.write('s2', spent('s2', 'u3'), said('s2', 'Done.'), ended('s2', T0 + 60))
    w.files.write('s3', said('s3', 'Late.'), spent('s3', 'u-ghost'))
    w.files.write(
      's4',
      started('s4'),
      said('s4', 'Hello.'),
      spent('s4', 'u5'),
      ended('s4', T0 + 90)
    )

    // Boot 1: s1's file is busy (drift), s2 is written, and the Host dies reading s3.
    w.files.failOnce.add('s1')
    w.files.hangAt = 's3'
    const died = new Promise<void>((resolve) => (w.files.onHang = resolve))
    void w.boot().catchUp()
    await died
    expect(w.sink.applied.flatMap((b) => b.usage.map((u) => u.unitKey))).toEqual(['u3'])
    expect(w.cursors.get('s3')?.value).toBe(1)

    // Boot 2: s1's batch fails inside its transaction (rolled back whole), the rest resumes from
    // each cursor: s2 is not departed twice, s3 is not resurrected, and s4, whose first batch
    // already states its ending, never arrives (owner decision 2026-10-10: a session whose
    // process is not alive at first sight never arrives as a present dwarf).
    w.files.hangAt = null
    w.sink.failNext(new Error('disk I/O error while writing the batch'))
    const second = w.boot()
    await second.catchUp()
    expect(w.cursors.get('s1')?.value).toBe(1)
    expect(w.cursors.get('s3')?.value).toBe(3)
    // Its live loop writes what waited: s1 at the next cycle.
    second.start()
    await second.whenIdle()
    w.clock.advance(OBSERVATION_POLL_MS)
    await second.whenIdle()
    second.stop()

    // Every unit spent while no Host ran by a session the Host knew is credited exactly once;
    // nothing for the ended s3, and nothing for s4, which never had a dwarf to credit (the owner
    // decision of 2026-10-10 keeps 09 §5.4 for streams that already have a cursor).
    const credited = w.sink.applied.flatMap((b) => b.usage.map((u) => u.unitKey))
    expect([...credited].sort()).toEqual(['u1', 'u2', 'u3'])
    // s2 departed once; s1 survived; s3 never came back; s4 never arrived, so never departs.
    const since = w.bus.published.slice(beforeEvents)
    const of = (type: ObservationEvent['type']) =>
      since.flatMap((e) =>
        e.type === type && 'identity' in e.payload ? [e.payload.identity.providerSessionId] : []
      )
    expect(of('SessionClosedObserved')).toEqual(['s2'])
    expect(w.dwarfs.bound(identity('s1'))?.departedAt).toBeNull()
    expect(of('SessionObserved')).toEqual([])
    // The faults left records without anything the provider wrote (ADR-026 item 4).
    expect(w.log.byEvent('observation.drift')).toHaveLength(1)
    expect(w.log.byEvent('observation.batch-failed')).toHaveLength(1)
    expect(w.log.refused).toEqual([])

    // Boot 3: nothing new since; catch-up publishes and credits nothing.
    const published = w.bus.published.length
    const applied = w.sink.applied.length
    await w.boot().catchUp()
    expect(w.bus.published.length).toBe(published)
    expect(w.sink.applied.length).toBe(applied)
  })
})
