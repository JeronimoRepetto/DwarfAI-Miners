// L2 (17 §1.2): `ingest` of observed entries — what an observer read from a transcript — over the
// in-memory doubles, which run the same `MessageLog` contract as `SqliteMessageLog` (17 §1.3); the
// same behaviour over the real tables is the flow suite's (host/wiring/flows/
// observedConversation.flow.test.ts).
import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../../suppliers'
import {
  CONVERSATION_DWARF as DWARF,
  CONVERSATION_T0 as T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'

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
    const c = inMemoryConversation()
    // DwarfAI typed the text into the observed terminal: its row waits, keyed by the relay's
    // text-delivery correlation (ADR-007 item 3), which the transcript cannot carry.
    const waiting = c.log.seedWaitingRow(DWARF, 'typed:relay-1', 'Dig the north seam')
    // The transcript shows the same text a few seconds later, as the person's message.
    const echo = observed(1, {
      role: 'person',
      text: 'Dig the north seam',
      providerTime: T0 + 4_000
    })

    c.commands.ingest(DWARF, [echo], 'transcript')

    expect(c.log.rowIds(DWARF)).toEqual([waiting])
    expect(c.log.keyOf(echo.sourceKey)).toEqual({ dwarfId: DWARF, messageId: waiting })
    expect(c.log.page(DWARF, {})).toEqual([
      {
        sourceKey: echo.sourceKey,
        role: 'person',
        text: 'Dig the north seam',
        providerTime: T0 + 4_000
      }
    ])
    expect(c.bus.ofType('MessagesAppended')).toEqual([])
  })

  it('[ADR-007] an observed entry keeps its providerTime and orders by it in the page', () => {
    const c = inMemoryConversation()
    // Read in two cycles, the later cycle carrying the earlier provider time (a catch-up read).
    c.commands.ingest(DWARF, [observed(30), observed(20)], 'transcript')
    c.clock.advance(60_000)
    c.commands.ingest(DWARF, [observed(10)], 'transcript')

    expect(c.log.page(DWARF, {}).map((e) => [e.text, e.providerTime])).toEqual([
      ['observed message 30', T0 + 30],
      ['observed message 20', T0 + 20],
      ['observed message 10', T0 + 10]
    ])
  })

  it("[ADR-007, INV-60] an ingest called inside the caller's open transaction joins it and holds its events until the caller publishes them after the commit", () => {
    // An unguarded bus records a publish made inside the transaction instead of refusing it.
    const c = inMemoryConversation({ guardedBus: false })
    const insideTransaction: number[] = []

    c.runner.inTransaction(() => {
      c.commands.ingest(DWARF, [observed(1)], 'transcript')
      insideTransaction.push(c.bus.published.length)
    })
    const beforePublish = c.bus.published.length
    c.commands.publishJoined()

    expect(insideTransaction).toEqual([0])
    expect(beforePublish).toBe(0)
    // Joined: the caller's one transaction, not one of its own.
    expect(c.transactions()).toBe(1)
    expect(
      c.bus.ofType('MessagesAppended').map((e) => e.payload.messages.map((m) => m.text))
    ).toEqual([['observed message 1']])

    // A rolled-back caller transaction leaves no row, and its events are discarded, never published.
    expect(() =>
      c.runner.inTransaction(() => {
        c.commands.ingest(DWARF, [observed(2)], 'transcript')
        throw new Error('the caller failed after the ingest')
      })
    ).toThrow('the caller failed after the ingest')
    c.commands.discardJoined()
    c.commands.publishJoined()

    expect(c.log.rowCount(DWARF)).toBe(1)
    expect(c.bus.ofType('MessagesAppended')).toHaveLength(1)
  })
})
