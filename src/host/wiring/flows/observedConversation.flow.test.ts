// layer: L2
// L2 flow (17 §1.2; 11 F1 "Observed session appears", conversation half; 12 UC-024): observation
// and conversation composed through their public index.ts over one copy of the template database,
// with the conversation half of the `ObservedBatchSink` bridge declared here as `host/wiring` will
// declare it (later: ISSUE-120; AMENDMENT-10, OQ-78):
//
// - observation calls `apply(batch)` inside its batch transaction, before `CursorStore.advance`;
//   the bridge hands the entries to `conversation.ingest`, which joins that transaction (16 §2.2);
// - the events `ingest` held are published only after that transaction committed, and dropped
//   when it rolled back (16 §2.3, 09 §5.2 step 6) — the transaction runner observation is given
//   does that around each batch.
//
// The observed dwarfs exist already (seeded `dwarfs` rows, as `crew.arrive` leaves them), so every
// batch is written at once instead of held for the arrival route (that route is
// observedSessionAppears.test.ts). The provider observation adapters are not built yet (later:
// ISSUE-071…ISSUE-075), so each observer's transcript is a stand-in fixture replayed by a
// test-local `FixtureObserver`: the records its adapter yields, with 15 §1.5 source keys and the
// control-plane records that adapter flags (ADR-007 item 3). Every text is invented.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, ProviderIdentity } from '../../kernel/domain/values'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { createConversation, type ConversationEvent } from '../../modules/conversation'
import {
  OBSERVATION_POLL_MS,
  createObservation,
  createSqliteObservationStores,
  type Cursor,
  type ObservationAdapter,
  type ObservationEvent,
  type ObservedBatchSink,
  type ObservedEvent,
  type SourceFile
} from '../../modules/observation'
import type { ConversationEntry } from '../../modules/suppliers'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000000f9'
const OBSERVERS = ['claude', 'codex', 'antigravity', 'opencode'] as const
type Observer = (typeof OBSERVERS)[number]

const identityOf = (provider: Observer): ProviderIdentity => ({
  providerId: provider,
  providerSessionId: `session-${provider}`
})

/** One observed message record, keyed by the 15 §1.5 rule `<adapterId>:<streamId>:<eventId>`. */
function record(
  provider: Observer,
  eventId: string,
  entry: Omit<ConversationEntry, 'sourceKey'>,
  agentId?: string
): ObservedEvent {
  const stream = [provider, `session-${provider}`, ...(agentId === undefined ? [] : [agentId])]
  return {
    kind: 'entries',
    sourceEventId: eventId,
    identity: identityOf(provider),
    entries: [
      {
        sourceKey: `${provider}:${stream.join(':')}:${eventId}`,
        ...entry,
        ...(agentId === undefined ? {} : { providerAgentId: agentId })
      }
    ]
  }
}

/**
 * The stand-in fixture of one observer: a person message, a dwarf reply and a system line, two
 * control-plane records the adapter flags (a warm-up and a context record), and, for Claude, a
 * reply a subagent wrote in its parent's session.
 */
function fixtureOf(provider: Observer): ObservedEvent[] {
  const at = (n: number) => T0 + n * 1_000
  const records = [
    record(provider, 'e1', { role: 'person', text: 'Survey the east tunnel', providerTime: at(1) }),
    record(provider, 'e2', {
      role: 'system-line',
      text: 'warm-up',
      providerTime: at(2),
      controlPlane: true
    }),
    record(provider, 'e3', {
      role: 'dwarf',
      text: 'The east tunnel holds iron',
      providerTime: at(3)
    }),
    record(provider, 'e4', {
      role: 'system-line',
      text: 'context record',
      providerTime: at(4),
      controlPlane: true
    }),
    record(provider, 'e5', { role: 'system-line', text: 'Turn interrupted', providerTime: at(5) })
  ]
  if (provider === 'claude') {
    records.push(
      record(
        provider,
        'e6',
        { role: 'dwarf', text: 'Subagent survey done', providerTime: at(6) },
        'agent-1'
      )
    )
  }
  return records
}

const messagesIn = (events: ObservedEvent[]) =>
  events.flatMap((e) => (e.kind === 'entries' ? e.entries : []))

/**
 * A stand-in observer over in-memory transcript files (16 §4.3 `ObservationAdapter`): one stream
 * per file, read from a watermark cursor (the count of records read), the same records with the
 * same ids at every read (HO-37).
 */
class FixtureObserver implements ObservationAdapter {
  readonly cursorKind = 'watermark' as const
  private readonly files = new Map<string, ObservedEvent[]>()

  constructor(readonly providerId: Observer) {}

  capabilities(): ReturnType<ObservationAdapter['capabilities']> {
    return {}
  }

  write(copy: string, records: ObservedEvent[]): void {
    this.files.set(copy, records)
  }

  discover(): Promise<SourceFile[]> {
    return Promise.resolve(
      [...this.files].map(([copy, records]) => ({
        streamId: `${this.providerId}:file-${copy}`,
        adapterId: this.providerId,
        path: copy,
        fileIdentity: `${this.providerId}-${copy}`,
        size: records.length
      }))
    )
  }

  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    const records = this.files.get(source.path) ?? []
    return Promise.resolve({
      events: records.slice(from?.value ?? 0),
      next: {
        adapterId: this.providerId,
        kind: 'watermark',
        value: records.length,
        fileIdentity: source.fileIdentity
      },
      warnings: []
    })
  }
}

/** A `SqliteDatabase` whose next `INSERT INTO messages` after `armAt` successful ones throws. */
function faultyMessageInserts(db: SqliteDatabase) {
  let armed: number | null = null
  const wrapped: SqliteDatabase = {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.all(sql, params),
    openReader: () => db.openReader(),
    close: () => db.close(),
    run: (sql, params) => {
      if (armed !== null && sql.trimStart().startsWith('INSERT INTO messages')) {
        if (armed === 0) {
          armed = null
          throw new Error('disk I/O error while writing the batch')
        }
        armed -= 1
      }
      return db.run(sql, params)
    }
  }
  return {
    db: wrapped,
    /** The insert after `successful` more inserts fails once. */
    failAfter(successful: number) {
      armed = successful
    }
  }
}

/** The Host slice over one template copy; `restart` is a Host exit and a new Host (S4.37). */
function host() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  // One bus per module's event union (as each module's composition is typed), both refusing a
  // publish inside a transaction (16 §2.3).
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
  const observationBus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const log = new RecordingDiagnosticsLog()
  const faulty = faultyMessageInserts(db)

  // The observed dwarfs, as crew leaves them after their arrival (09 §4.3).
  const dwarfOf = new Map<Observer, DwarfId>()
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-nine', 'mine-nine', 'mine-nine', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    OBSERVERS.forEach((provider, n) => {
      const id = `00000000-0000-7000-8000-0000000000e${n}` as DwarfId
      dwarfOf.set(provider, id)
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, ?, ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
        [id, MINE, provider, `session-${provider}`, T0, T0]
      )
    })
  })

  const observers = new Map<Observer, FixtureObserver>(
    OBSERVERS.map((provider): [Observer, FixtureObserver] => [
      provider,
      new FixtureObserver(provider)
    ])
  )
  /** `provider`'s transcript file `copy` now holds `records`; another `copy` is a second path. */
  const write = (provider: Observer, records: ObservedEvent[], copy = 'main') =>
    observers.get(provider)!.write(copy, records)

  const stores = createSqliteObservationStores({ db, scope: transactions, clock })
  let epoch = 0
  const boot = () => {
    epoch += 1
    const hostEpoch = `epoch-0099-${epoch}`
    const conversation = createConversation({
      db: faulty.db,
      transactions,
      bus,
      clock,
      ids,
      hostEpoch
    })
    // The conversation half of the ObservedBatchSink bridge (ISSUE-120 registers it).
    const sink: ObservedBatchSink = {
      apply: (batch) => conversation.commands.ingest(batch.dwarfId, batch.entries, 'transcript')
    }
    // Each batch transaction, then the events conversation held: after the commit, or dropped.
    const batchTransactions: TransactionRunner = {
      inTransaction<T>(work: () => T): T {
        let result: T
        try {
          result = transactions.inTransaction(work)
        } catch (error) {
          conversation.joinedEvents.discard()
          throw error
        }
        conversation.joinedEvents.publish()
        return result
      }
    }
    const observation = createObservation({
      adapters: [...observers.values()],
      fs: new FakeFs(),
      ...stores,
      sink,
      transactions: batchTransactions,
      bus: observationBus,
      clock,
      scheduler,
      ids,
      hostEpoch,
      log
    })
    return { conversation, observation }
  }
  let running = boot()

  const count = (table: 'messages' | 'message_keys') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  const keyRow = (sourceKey: string) =>
    db.all('SELECT message_id FROM message_keys WHERE source_key = ?', [sourceKey])[0] ?? null
  const rowWithKey = (sourceKey: string) =>
    db.all('SELECT id FROM messages WHERE source_key = ?', [sourceKey]).length

  return {
    clock,
    bus,
    observationBus,
    log,
    stores,
    faulty,
    write,
    count,
    keyRow,
    rowWithKey,
    dwarfOf: (provider: Observer) => dwarfOf.get(provider)!,
    /** `ConversationQueries.feed` over the Host database: what a reopened chat reads (ADR-007 item 6, ISSUE-103). */
    page: (provider: Observer) =>
      running.conversation.queries.feed(dwarfOf.get(provider)!).messages,
    get observation() {
      return running.observation
    },
    /** The Host stops (Stop everything) … */
    stop() {
      running.observation.control.stop()
    },
    /** … and a new Host boots over the same database and starts observing. */
    restart() {
      running.observation.control.stop()
      running = boot()
      running.observation.control.start()
    },
    async poll() {
      await running.observation.whenIdle()
      clock.advance(OBSERVATION_POLL_MS)
      await running.observation.whenIdle()
    }
  }
}

describe('observer fixtures into the message log', () => {
  for (const provider of OBSERVERS) {
    it(`[C-19, INV-60] every ${provider} observer fixture replayed twice inserts its messages once and zero rows the second time`, async () => {
      const h = host()
      const fixture = fixtureOf(provider)
      const shown = messagesIn(fixture).filter((e) => e.controlPlane !== true)
      h.write(provider, fixture)
      h.observation.control.start()
      await h.observation.whenIdle()
      const first = { messages: h.count('messages'), keys: h.count('message_keys') }

      // The same records reached again: a second path to the same transcript (another source).
      h.write(provider, fixtureOf(provider), 'copy')
      await h.poll()

      expect(first).toEqual({ messages: shown.length, keys: fixture.length })
      expect({ messages: h.count('messages'), keys: h.count('message_keys') }).toEqual(first)
      expect(h.page(provider).map((e) => e.text)).toEqual(shown.map((e) => e.text).reverse())
      expect(
        h.bus.ofType('MessagesAppended').map((e) => [e.payload.dwarfId, e.payload.messages.length])
      ).toEqual([[h.dwarfOf(provider), shown.length]])
      h.stop()
    })

    it(`[ADR-007] control-plane records of the ${provider} fixtures leave keys and no message rows`, async () => {
      const h = host()
      const controlPlane = messagesIn(fixtureOf(provider)).filter((e) => e.controlPlane === true)
      h.write(provider, fixtureOf(provider))
      h.observation.control.start()
      await h.observation.whenIdle()

      expect(controlPlane).toHaveLength(2)
      for (const entry of controlPlane) {
        expect(h.keyRow(entry.sourceKey)).toEqual({ message_id: null })
        expect(h.rowWithKey(entry.sourceKey)).toBe(0)
      }
      expect(h.page(provider).map((e) => e.text)).not.toContain('warm-up')
      h.stop()
    })
  }
})

describe('reopen with offline activity (UC-024)', () => {
  it("[US-RES-003.AC01, ADR-007] messages written to a live session's transcript while the Host was stopped are in the log after the Host restarts and catches up", async () => {
    const h = host()
    const transcript = fixtureOf('codex').slice(0, 3)
    h.write('codex', transcript)
    h.observation.control.start()
    await h.observation.whenIdle()
    h.stop()
    const beforeRestart = h.bus.ofType('MessagesAppended').length

    // While the Host is stopped the session goes on writing its transcript.
    h.clock.advance(3_600_000)
    const offline = [
      record('codex', 'e10', {
        role: 'person',
        text: 'Shore up the shaft',
        providerTime: T0 + 900_000
      }),
      record('codex', 'e11', { role: 'dwarf', text: 'Shaft shored up', providerTime: T0 + 960_000 })
    ]
    h.write('codex', [...transcript, ...offline])
    // The next Host reads every stream from its cursor at boot (the catch-up; ObservationControl
    // .catchUp joins with ISSUE-078 and reads the same way).
    h.restart()
    await h.observation.whenIdle()

    // The whole conversation, in provider order (newest first), without a provider read.
    expect(h.page('codex').map((e) => [e.text, e.providerTime])).toEqual([
      ['Shaft shored up', T0 + 960_000],
      ['Shore up the shaft', T0 + 900_000],
      ['The east tunnel holds iron', T0 + 3_000],
      ['Survey the east tunnel', T0 + 1_000]
    ])
    // The restarted Host published only what was new to the log.
    const afterRestart = h.bus.ofType('MessagesAppended').slice(beforeRestart)
    expect(afterRestart.map((e) => e.payload.messages.map((m) => m.text))).toEqual([
      ['Shore up the shaft', 'Shaft shored up']
    ])
    expect(afterRestart[0]?.hostEpoch).toBe('epoch-0099-2')
    h.stop()
  })

  it('[FM-137, ADR-006] a failure while the batch is being written leaves the cursor where it was, and the next cycle writes each message once', async () => {
    const h = host()
    const transcript = fixtureOf('opencode')
    const shown = messagesIn(transcript).filter((e) => e.controlPlane !== true)
    h.write('opencode', transcript)
    // The batch's second message row fails after its first one was written.
    h.faulty.failAfter(1)

    h.observation.control.start()
    await h.observation.whenIdle()

    // Rolled back whole: no row, no key, no cursor past an unwritten message, nothing published.
    expect(h.count('messages')).toBe(0)
    expect(h.count('message_keys')).toBe(0)
    expect(h.stores.cursors.get('opencode:file-main')).toBeNull()
    expect(h.bus.ofType('MessagesAppended')).toEqual([])
    expect(h.observationBus.ofType('TranscriptEntriesObserved')).toEqual([])
    expect(h.log.entries.map((e) => e.event)).toContain('observation.batch-failed')

    // The next cycle re-reads the batch from the old position and writes each message once.
    await h.poll()
    await h.poll()

    expect(h.page('opencode').map((e) => e.text)).toEqual(shown.map((e) => e.text).reverse())
    expect(h.count('messages')).toBe(shown.length)
    expect(h.stores.cursors.get('opencode:file-main')?.value).toBe(transcript.length)
    expect(h.bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([
      shown.length
    ])
    h.stop()
  })
})
