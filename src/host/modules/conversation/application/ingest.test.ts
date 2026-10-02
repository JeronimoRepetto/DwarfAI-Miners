import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../../suppliers'
import {
  CONVERSATION_DWARF as DWARF,
  CONVERSATION_EPOCH,
  CONVERSATION_T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'

// L2 (17 §1.2): `ingest` over the in-memory doubles. One batch is one transaction (09 §5.2), and
// `MessagesAppended` follows the commit with the batch's new rows only (08 §5.1).
const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `codex:codex:thread-1:item-${n}`,
  role: 'dwarf',
  text: `message ${n}`,
  providerTime: CONVERSATION_T0 + n,
  ...extra
})

describe('ConversationCommands.ingest', () => {
  it('[ADR-007] one batch is one transaction: an entry that fails a CHECK rolls back every row of the batch and publishes nothing', () => {
    // No bus guard here: a publish before the commit would be recorded, not refused.
    const c = inMemoryConversation({ guardedBus: false })
    const tooLong = entry(2, { text: 'x'.repeat(65_537) })

    expect(() => c.commands.ingest(DWARF, [entry(1), tooLong, entry(3)], 'transcript')).toThrow()

    expect(c.transactions()).toBe(1)
    expect(c.log.rowCount(DWARF)).toBe(0)
    expect([1, 2, 3].map((n) => c.log.keyOf(entry(n).sourceKey))).toEqual([null, null, null])
    expect(c.bus.published).toEqual([])
  })

  it('[ADR-006] MessagesAppended is published after the commit and carries only the rows inserted by this batch', () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry(1)], 'live-stream')
    c.clock.advance(1_000)
    // What a subscriber sees when the event arrives: no open transaction, the rows committed.
    const seen: Array<{ inTransaction: boolean; rows: number }> = []
    c.bus.subscribe('MessagesAppended', () =>
      seen.push({ inTransaction: c.scope.isInTransaction(), rows: c.log.rowCount(DWARF) })
    )

    // Entry 1 is already stored, entry 3 is a control-plane record: only entry 2 is new.
    c.commands.ingest(DWARF, [entry(1), entry(2), entry(3, { controlPlane: true })], 'transcript')
    // A batch whose every key was already claimed publishes nothing (TC-098-01).
    c.commands.ingest(DWARF, [entry(1), entry(2), entry(3)], 'live-stream')

    const events = c.bus.ofType('MessagesAppended')
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({
      type: 'MessagesAppended',
      v: 1,
      id: expect.any(String),
      at: CONVERSATION_T0 + 1_000,
      hostEpoch: CONVERSATION_EPOCH,
      payload: {
        dwarfId: DWARF,
        messages: [
          {
            id: expect.any(String),
            dwarfId: DWARF,
            role: 'dwarf',
            text: 'message 2',
            attachments: [],
            providerTime: CONVERSATION_T0 + 2,
            createdAt: CONVERSATION_T0 + 1_000
          }
        ]
      }
    })
    expect(seen).toEqual([{ inTransaction: false, rows: 2 }])
  })
})
