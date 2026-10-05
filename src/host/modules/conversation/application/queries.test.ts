// L2 (17 §1.2): `ConversationQueries.feed` (16 §4.6; 14 §3.6 `FeedPage`; ADR-007 item 6) over the
// in-memory doubles, which run the same `MessageLog` contract as `SqliteMessageLog` (17 §1.3): a
// dwarf's feed from the Host's message log alone, newest first by provider time, at most 50 rows,
// `reachedStart` once the oldest stored row is in the page.
import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../../suppliers'
import {
  CONVERSATION_DWARF as DWARF,
  CONVERSATION_T0 as T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'
import { ConversationFeedQueries } from './queries'

/** What a transcript observer reads (15 §1.5 key shape); never real conversation text. */
const observed = (n: number): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:event-${n}`,
  role: n % 2 === 0 ? 'person' : 'dwarf',
  text: `observed message ${n}`,
  providerTime: T0 + n
})

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('conversation queries, feed', () => {
  it('[ADR-007] feed returns the newest messages first and reachedStart once the oldest stored row is included', () => {
    const c = inMemoryConversation()
    // Read in two cycles, the later one carrying older provider times (a catch-up read).
    c.commands.ingest(DWARF, range(11, 30).map(observed), 'transcript')
    c.clock.advance(60_000)
    c.commands.ingest(DWARF, range(1, 10).map(observed), 'transcript')
    const queries = new ConversationFeedQueries({ log: c.log })

    const tail = queries.feed(DWARF, { limit: 20 })
    expect(tail.dwarfId).toBe(DWARF)
    expect(tail.messages.map((m) => m.text)).toEqual(
      range(11, 30)
        .reverse()
        .map((n) => `observed message ${n}`)
    )
    expect(tail.reachedStart).toBe(false)
    // A page that holds exactly the oldest row reached the start; one row short did not.
    expect(queries.feed(DWARF, { limit: 30 }).reachedStart).toBe(true)
    expect(queries.feed(DWARF, { limit: 29 }).reachedStart).toBe(false)
    const all = queries.feed(DWARF)
    expect(all.messages).toHaveLength(30)
    expect(all.reachedStart).toBe(true)
    // Items are MessageView: the stored row without sourceKey, origin and askId (06 §0.2).
    for (const view of all.messages) {
      expect(Object.keys(view).sort()).toEqual(
        ['attachments', 'createdAt', 'dwarfId', 'id', 'providerTime', 'role', 'text'].sort()
      )
    }
    // A dwarf with no stored row: an empty page at its start.
    expect(queries.feed('00000000-0000-7000-8000-0000000000d9' as typeof DWARF)).toEqual({
      dwarfId: '00000000-0000-7000-8000-0000000000d9',
      messages: [],
      reachedStart: true
    })
  })

  it('[ADR-007] a page before a given message returns only older rows and never more than 50', () => {
    const c = inMemoryConversation()
    // 60 rows written without the ingest trim, so the log holds more than one page.
    c.runner.inTransaction(() => c.log.append(DWARF, range(1, 60).map(observed), 'transcript'))
    const queries = new ConversationFeedQueries({ log: c.log })

    // A caller asking for more than 50 gets 50 (INV-61), and the start is not reached.
    const newest = queries.feed(DWARF, { limit: 80 })
    expect(newest.messages).toHaveLength(50)
    expect(newest.messages[0]?.text).toBe('observed message 60')
    expect(newest.reachedStart).toBe(false)
    expect(queries.feed(DWARF).messages).toHaveLength(50)

    // Before the 20th newest (message 41): only the older rows, newest first.
    const before = newest.messages[19]?.id
    const older = queries.feed(DWARF, { before, limit: 15 })
    expect(older.messages.map((m) => m.text)).toEqual(
      range(26, 40)
        .reverse()
        .map((n) => `observed message ${n}`)
    )
    expect(older.reachedStart).toBe(false)
    const rest = queries.feed(DWARF, { before: older.messages.at(-1)?.id })
    expect(rest.messages.map((m) => m.text)).toEqual(
      range(1, 25)
        .reverse()
        .map((n) => `observed message ${n}`)
    )
    expect(rest.reachedStart).toBe(true)
  })
})
