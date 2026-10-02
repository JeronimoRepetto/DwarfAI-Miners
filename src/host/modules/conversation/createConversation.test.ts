// The module as wired by its composition over a template-database copy (17 §1.5): the real
// `messages` CHECK and UNIQUE keys behind `ingest`, read back from the rows.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../suppliers'
import { createConversation, type ConversationEvent } from './index'
import { seedConversationDb } from './testing/sqliteConversationDb'

const T0 = 1_790_000_000_000

function setUp() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const [dwarf] = seedConversationDb(db, transactions, T0)
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
  const conversation = createConversation({
    db,
    transactions,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0098'
  })
  const count = (table: 'messages' | 'message_keys') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  return { conversation, bus, dwarf, count }
}

const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:event-${n}`,
  role: 'dwarf',
  text: `message ${n}`,
  providerTime: T0 + n,
  ...extra
})

describe('createConversation', () => {
  it('[INV-60, ADR-006] the same message from the live stream and from the transcript is stored once and published once', () => {
    const { conversation, bus, dwarf, count } = setUp()

    conversation.commands.ingest(dwarf, [entry(1)], 'live-stream')
    conversation.commands.ingest(dwarf, [entry(1)], 'transcript')

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(1)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  it('[INV-68] a control-plane record and a hand-off echo leave keys and no rows, and a replay stays a no-op', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const dropped = [entry(1, { controlPlane: true }), entry(2, { handoffEcho: true })]

    conversation.commands.ingest(dwarf, dropped, 'transcript')
    conversation.commands.ingest(dwarf, [entry(1), entry(2)], 'live-stream')

    expect(count('messages')).toBe(0)
    expect(count('message_keys')).toBe(2)
    expect(bus.published).toEqual([])
  })

  it('[ADR-007] a 65 537-byte text fails the messages CHECK and rolls back the whole batch with nothing published', () => {
    const { conversation, bus, dwarf, count } = setUp()

    expect(() =>
      conversation.commands.ingest(
        dwarf,
        [entry(1), entry(2, { text: 'x'.repeat(65_537) })],
        'live-stream'
      )
    ).toThrow(/CHECK constraint failed/)

    expect(count('messages')).toBe(0)
    expect(count('message_keys')).toBe(0)
    expect(bus.published).toEqual([])
  })
})
