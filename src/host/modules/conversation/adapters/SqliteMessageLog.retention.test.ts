// L5 (17 §1.5) on the template database, the 09 §6.5 "Trim" row: the storage cap of 09 §5.2
// step 3 as `ingest` runs it, read back from the rows themselves, with the cascades of 09 §4.4.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../../suppliers'
import { ConversationIngest } from '../application/ingest'
import type { ConversationEvent } from '../domain/events'
import { seedConversationDb, sqliteProbe } from '../testing/sqliteConversationDb'
import { SqliteActivityLog } from './SqliteActivityLog'
import { SqliteMessageLog } from './SqliteMessageLog'

const T0 = 1_790_000_000_000
const ASK = '00000000-0000-7000-8000-0000000000a1'

// Newer than every seeded row (seeds are stamped T0), oldest first.
const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:event-${n}`,
  role: 'dwarf',
  text: `message ${n}`,
  providerTime: T0 + n,
  ...extra
})
const entries = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => entry(from + i))

function setUp() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  const ids = new SequenceIdGenerator()
  const [dwarf] = seedConversationDb(db, runner, T0)
  const probe = sqliteProbe(db, runner, ids, T0)
  // Counts the transactions `ingest` opens.
  let opened = 0
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      opened += 1
      return runner.inTransaction(work)
    }
  }
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: runner })
  const clock = new FakeClock(T0)
  const log = new SqliteMessageLog({ db, scope: runner, clock, ids })
  const ingest = new ConversationIngest({
    log,
    activity: new SqliteActivityLog({ db, scope: runner }),
    transactions,
    scope: runner,
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-0105'
  })
  const count = (table: 'messages' | 'message_keys' | 'deliveries') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table} WHERE dwarf_id = ?`, [dwarf])[0]?.['n'])
  const keyOf = (sourceKey: string) =>
    db.all('SELECT message_id FROM message_keys WHERE source_key = ?', [sourceKey])
  return {
    db,
    runner,
    dwarf: dwarf as DwarfId,
    probe,
    ingest,
    log,
    bus,
    count,
    keyOf,
    transactions: () => opened
  }
}

describe('SqliteMessageLog retention on schema v1', () => {
  it('[INV-61] the trim runs in the inserting transaction and cascades to deliveries while message_keys keep their key with message_id NULL', () => {
    const s = setUp()
    // The oldest row: a DwarfAI-sent message merged with its echo and delivered.
    const sent = s.probe.seedWaitingRow(s.dwarf, 'send-request-1', 'hello')
    s.ingest.ingest(
      s.dwarf,
      [entry(0, { role: 'person', text: 'hello', providerTime: T0, echoOf: 'send-request-1' })],
      'live-stream'
    )
    s.runner.inTransaction(() =>
      s.db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
         VALUES (?, ?, 'message', 'delivered', ?, ?)`,
        [sent, s.dwarf, T0, T0]
      )
    )
    const before = s.transactions()
    // What a subscriber sees once the batch is published: the batch already committed, trimmed.
    const seen: number[] = []
    s.bus.subscribe('MessagesAppended', () => seen.push(s.count('messages')))

    s.ingest.ingest(s.dwarf, entries(1, 50), 'transcript')

    expect(s.transactions() - before).toBe(1)
    expect(seen).toEqual([50])
    expect(s.count('messages')).toBe(50)
    expect(s.db.all('SELECT id FROM messages WHERE id = ?', [sent])).toEqual([])
    expect(s.count('deliveries')).toBe(0)
    expect(s.keyOf(entry(0).sourceKey)).toEqual([{ message_id: null }])
    expect(s.count('message_keys')).toBe(51)
  })

  it('[INV-68] a dropped control-plane or hand-off-echo record leaves a key and no row, so the 50 rows are all showable', () => {
    const s = setUp()
    const dropped = [
      entry(1000, { controlPlane: true, text: 'Warmup' }),
      entry(1001, { handoffEcho: true, role: 'person' })
    ]

    s.ingest.ingest(s.dwarf, [...entries(1, 25), ...dropped, ...entries(26, 51)], 'transcript')

    expect(s.count('messages')).toBe(50)
    expect(s.count('message_keys')).toBe(53)
    expect(dropped.map((e) => s.keyOf(e.sourceKey))).toEqual([
      [{ message_id: null }],
      [{ message_id: null }]
    ])
    const page = s.log.page(s.dwarf, {})
    expect(page).toHaveLength(50)
    expect(page.map((e) => e.sourceKey)).toEqual(
      entries(2, 51)
        .reverse()
        .map((e) => e.sourceKey)
    )
  })

  it('[INV-61] ask_answers.message_id becomes NULL when its answers-record row is trimmed', () => {
    const s = setUp()
    const record = '00000000-0000-7000-8000-0000000000b1' as MessageId
    s.runner.inTransaction(() => {
      s.db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at, closed_at)
         VALUES (?, ?, 'question', 'driver', 'request-1', '{}', 'answered-in-app', ?, ?)`,
        [ASK, s.dwarf, T0, T0]
      )
      s.db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, ask_id, created_at)
         VALUES (?, ?, 'answers-record', 'Answers: yes', 'dwarfai', ?, ?)`,
        [record, s.dwarf, ASK, T0]
      )
      s.db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
         VALUES (?, ?, 'answers-record', 'delivered', ?, ?)`,
        [record, s.dwarf, T0, T0]
      )
      s.db.run(
        `INSERT INTO ask_answers (request_id, ask_id, outcome, message_id, at, settled_at)
         VALUES ('answer-request-1', ?, 'accepted', ?, ?, ?)`,
        [ASK, record, T0, T0]
      )
    })

    s.ingest.ingest(s.dwarf, entries(1, 50), 'live-stream')

    expect(s.db.all('SELECT id FROM messages WHERE id = ?', [record])).toEqual([])
    expect(s.count('deliveries')).toBe(0)
    expect(s.db.all('SELECT request_id, ask_id, message_id FROM ask_answers')).toEqual([
      { request_id: 'answer-request-1', ask_id: ASK, message_id: null }
    ])
    expect(s.db.all('SELECT id FROM asks')).toEqual([{ id: ASK }])
  })
})
