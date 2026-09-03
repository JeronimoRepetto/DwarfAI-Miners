import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { DwarfFeedResult } from '../../types'
import {
  NOTHING_SAID_NOTE,
  NO_TRANSCRIPT_NOTE,
  OBSERVED_NOTE,
  HELD_NOTE,
  READING_NOTE,
  conversationOf,
  latestText
} from './conversation'

const HELD = [
  { role: 'user' as const, text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
  { role: 'assistant' as const, text: 'Found the seam.', timestamp: '2026-09-03T09:00:01.000Z' }
]

describe('conversationOf', () => {
  it("draws a held session's own exchange, and says it is first-hand", () => {
    const shown = conversationOf(defaultDwarf({ conversation: HELD }))
    expect(shown.source).toBe('held')
    expect(shown.note).toBe(HELD_NOTE)
    expect(shown.messages.map((message) => [message.from, message.text])).toEqual([
      ['user', 'dig here'],
      ['agent', 'Found the seam.']
    ])
  })

  it('prefers the held exchange over a transcript read of the same session', () => {
    // Both can be present for a held session: the poll finds its transcript on
    // disk like any other. The first-hand one wins, because the tail is the
    // same words arriving second-hand and one turn behind.
    const shown = conversationOf(defaultDwarf({ conversation: HELD }), {
      readable: true,
      messages: [{ role: 'assistant', text: 'stale', timestamp: 'then' }]
    })
    expect(shown.source).toBe('held')
    expect(shown.messages).toHaveLength(2)
  })

  it("draws an observed session's transcript tail, and says what it is", () => {
    const shown = conversationOf(defaultDwarf(), {
      readable: true,
      messages: [{ role: 'assistant', text: 'Still working', timestamp: 'now' }]
    })
    expect(shown.source).toBe('observed')
    expect(shown.note).toBe(OBSERVED_NOTE)
    expect(shown.messages).toEqual([{ from: 'agent', text: 'Still working', key: 'agent-0-now' }])
  })

  it('shows the last message the poll already carries while the transcript read is in flight', () => {
    const shown = conversationOf(defaultDwarf({ lastMessage: 'Halfway down the shaft' }))
    expect(shown.source).toBe('observed')
    expect(shown.messages.map((message) => message.text)).toEqual(['Halfway down the shaft'])
  })

  it('says it is still reading when there is nothing to show yet', () => {
    const shown = conversationOf(defaultDwarf())
    expect(shown.source).toBe('none')
    expect(shown.note).toBe(READING_NOTE)
    expect(shown.messages).toEqual([])
  })

  it('tells a session that has said nothing from one it cannot read at all', () => {
    // The whole reason DwarfFeedResult carries `readable` separately: these
    // are two different facts about a session and they read differently.
    const silent = conversationOf(defaultDwarf(), { readable: true, messages: [] })
    expect(silent.source).toBe('none')
    expect(silent.note).toBe(NOTHING_SAID_NOTE)

    const unreadable = conversationOf(defaultDwarf(), { readable: false, messages: [] })
    expect(unreadable.source).toBe('none')
    expect(unreadable.note).toBe(NO_TRANSCRIPT_NOTE)
  })

  it('still shows the last message of a session whose transcript cannot be read', () => {
    // `lastMessage` came off the provider's own tail read, so it is evidence
    // even where a fuller read is not on offer — and dropping it would hide
    // the one thing the panel does know.
    const shown = conversationOf(defaultDwarf({ lastMessage: 'Blasting' }), {
      readable: false,
      messages: []
    })
    expect(shown.source).toBe('observed')
    expect(shown.messages.map((message) => message.text)).toEqual(['Blasting'])
  })

  it('never invents a bubble for a dwarf with nothing to say', () => {
    const nothing: (DwarfFeedResult | undefined)[] = [undefined, { readable: true, messages: [] }]
    for (const feed of nothing) {
      expect(conversationOf(defaultDwarf(), feed).messages).toEqual([])
    }
  })

  it('gives every message a key that is stable and its own', () => {
    const shown = conversationOf(
      defaultDwarf({
        conversation: [
          { role: 'assistant', text: 'one', timestamp: 'same' },
          { role: 'assistant', text: 'two', timestamp: 'same' }
        ]
      })
    )
    const keys = shown.messages.map((message) => message.key)
    expect(new Set(keys).size).toBe(2)
    expect(conversationOf(defaultDwarf({ conversation: HELD })).messages[0]!.key).toBe(
      conversationOf(defaultDwarf({ conversation: HELD })).messages[0]!.key
    )
  })
})

describe('latestText', () => {
  it('answers with the last message, which is what the panel sizes itself from', () => {
    expect(latestText(conversationOf(defaultDwarf({ conversation: HELD })))).toBe('Found the seam.')
  })

  it('answers with nothing when nothing was said', () => {
    expect(latestText(conversationOf(defaultDwarf()))).toBe('')
  })
})
