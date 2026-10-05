// L2 (17 §1.2): `ingest` of observed entries — what an observer read from a transcript — over the
// module as `createConversation` composes it on a template-database copy (17 §1.5), so the merge,
// the order and the transaction are the real `messages` / `message_keys` rows (09 §4.4, §5.2).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../../suppliers'
import { createConversation, type ConversationEvent } from '../index'
import { seedConversationDb, sqliteMessageLog, sqliteProbe } from '../testing/sqliteConversationDb'

const T0 = 1_790_000_000_000

function setUp(options: { guardedBus?: boolean } = {}) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const [dwarf] = seedConversationDb(db, transactions, T0)
  const bus = new RecordingEventBus<ConversationEvent>(
    options.guardedBus === false ? {} : { transactionScope: transactions }
  )
  const conversation = createConversation({
    db,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-0099'
  })
  const probe = sqliteProbe(db, transactions, ids, T0)
  // The read side of the log (feed paging is ISSUE-103); a read needs no transaction.
  const log = sqliteMessageLog({ db, scope: transactions, clock, ids })
  return { conversation, transactions, bus, clock, dwarf, probe, log }
}

/** What a transcript observer reads (15 §1.5 key shape); never real conversation text. */
const observed = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:event-${n}`,
  role: 'dwarf',
  text: `observed message ${n}`,
  providerTime: T0 + n,
  ...extra
})

describe('conversation ingest, observed entries', () => {
  it('[INV-60] an observed echo of a message DwarfAI typed into the terminal merges into the waiting row', () => {
    const { conversation, dwarf, probe, log } = setUp()
    // DwarfAI typed the text into the observed terminal: its row waits, keyed by the relay's
    // text-delivery correlation (ADR-007 item 3), which the transcript cannot carry.
    const waiting = probe.seedWaitingRow(dwarf, 'typed:relay-1', 'Dig the north seam')
    // The transcript shows the same text a few seconds later, as the person's message.
    const echo = observed(1, {
      role: 'person',
      text: 'Dig the north seam',
      providerTime: T0 + 4_000
    })

    conversation.commands.ingest(dwarf, [echo], 'transcript')

    expect(probe.rowIds(dwarf)).toEqual([waiting])
    expect(probe.keyOf(echo.sourceKey)).toEqual({ dwarfId: dwarf, messageId: waiting })
    expect(log.page(dwarf, {})).toEqual([
      {
        sourceKey: echo.sourceKey,
        role: 'person',
        text: 'Dig the north seam',
        providerTime: T0 + 4_000
      }
    ])
  })

  it('[ADR-007] an observed entry keeps its providerTime and orders by it in the page', () => {
    const { conversation, clock, dwarf, log } = setUp()
    // Read in two cycles, the later cycle carrying the earlier provider time (a catch-up read).
    conversation.commands.ingest(dwarf, [observed(30), observed(20)], 'transcript')
    clock.advance(60_000)
    conversation.commands.ingest(dwarf, [observed(10)], 'transcript')

    expect(log.page(dwarf, {}).map((e) => [e.text, e.providerTime])).toEqual([
      ['observed message 30', T0 + 30],
      ['observed message 20', T0 + 20],
      ['observed message 10', T0 + 10]
    ])
  })

  it("[ADR-007, INV-60] an ingest called inside the caller's open transaction joins it and holds its events until the caller publishes them after the commit", () => {
    // An unguarded bus records a publish made inside the transaction instead of refusing it.
    const { conversation, transactions, bus, dwarf, probe } = setUp({ guardedBus: false })
    const insideTransaction: number[] = []

    transactions.inTransaction(() => {
      conversation.commands.ingest(dwarf, [observed(1)], 'transcript')
      insideTransaction.push(bus.published.length)
    })
    const beforePublish = bus.published.length
    conversation.joinedEvents.publish()

    expect(insideTransaction).toEqual([0])
    expect(beforePublish).toBe(0)
    expect(
      bus.ofType('MessagesAppended').map((e) => e.payload.messages.map((m) => m.text))
    ).toEqual([['observed message 1']])
    expect(probe.rowCount(dwarf)).toBe(1)

    // A rolled-back caller transaction leaves no row, and its events are discarded, never published.
    expect(() =>
      transactions.inTransaction(() => {
        conversation.commands.ingest(dwarf, [observed(2)], 'transcript')
        throw new Error('the caller failed after the ingest')
      })
    ).toThrow('the caller failed after the ingest')
    conversation.joinedEvents.discard()
    conversation.joinedEvents.publish()

    expect(probe.rowCount(dwarf)).toBe(1)
    expect(bus.ofType('MessagesAppended')).toHaveLength(1)
  })
})
