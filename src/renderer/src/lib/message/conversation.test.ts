import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { DwarfFeedResult, DwarfStatus } from '../../types'
import {
  ENDED_NOTE,
  NOTHING_SAID_NOTE,
  NO_TRANSCRIPT_NOTE,
  OBSERVED_NOTE,
  HELD_NOTE,
  READING_NOTE,
  authorOf,
  conversationEnded,
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

  /**
   * A dwarf the board reports as leaving belongs to a session that has ended
   * (#192). The words are still what they were — first-hand or read from the
   * transcript — so the note keeps saying which, and says the ending in front.
   */
  it('says the session has ended in front of what it shows, for a leaving dwarf', () => {
    const observed = conversationOf(defaultDwarf({ status: 'leaving' }), {
      readable: true,
      messages: [{ role: 'assistant', text: 'Packing up.', timestamp: 'now' }]
    })
    expect(observed.source).toBe('observed')
    expect(observed.note).toBe(`${ENDED_NOTE} ${OBSERVED_NOTE}`)

    const held = conversationOf(defaultDwarf({ status: 'leaving', conversation: HELD }))
    expect(held.source).toBe('held')
    expect(held.note).toBe(`${ENDED_NOTE} ${HELD_NOTE}`)
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

  /**
   * One tool-call line per call, interleaved between the bubbles (#240). The
   * wire's `activity` rides straight through `panelMessagesOf` onto the same
   * `PanelMessage` every other row is, rather than a sibling shape the two
   * panel components would have to branch on separately.
   */
  describe('activity lines', () => {
    const RUN = { kind: 'run' as const, target: 'pnpm test' }

    it('carries a tool-call line through with its activity attached', () => {
      const shown = conversationOf(defaultDwarf(), {
        readable: true,
        messages: [{ role: 'assistant', text: 'Ran pnpm test', timestamp: 'now', activity: RUN }]
      })
      expect(shown.messages).toEqual([
        { from: 'agent', text: 'Ran pnpm test', key: 'agent-0-now', activity: RUN }
      ])
    })

    it('counts a tool-call line as exactly one message, same as a spoken one', () => {
      const shown = conversationOf(defaultDwarf(), {
        readable: true,
        messages: [
          { role: 'assistant', text: 'Found the seam.', timestamp: 't0' },
          { role: 'assistant', text: 'Ran pnpm test', timestamp: 't1', activity: RUN },
          { role: 'assistant', text: 'Tests pass.', timestamp: 't2' }
        ]
      })
      expect(shown.messages).toHaveLength(3)
    })

    it('leaves an ordinary spoken message with no activity field at all', () => {
      const shown = conversationOf(defaultDwarf(), {
        readable: true,
        messages: [{ role: 'assistant', text: 'Digging.', timestamp: 'now' }]
      })
      expect('activity' in shown.messages[0]!).toBe(false)
    })
  })
})

/**
 * WHOSE words a row is (#175). The wire names the issuer of a `user` turn no
 * human typed; what that does to the row is decided here, not in the panel.
 */
describe('conversationOf attribution', () => {
  const ISSUED = [
    {
      role: 'user' as const,
      text: 'survey the seam',
      timestamp: 't0',
      issuer: { role: 'foreman' as const, name: 'coordinator' }
    },
    { role: 'assistant' as const, text: 'On my way.', timestamp: 't1' }
  ]

  it("draws an issued prompt as an agent row rather than the user's", () => {
    const shown = conversationOf(defaultDwarf(), { readable: true, messages: ISSUED })
    expect(shown.messages.map((message) => message.from)).toEqual(['agent', 'agent'])
  })

  it('carries the issuer through, so the row can be drawn as who wrote it', () => {
    const shown = conversationOf(defaultDwarf(), { readable: true, messages: ISSUED })
    expect(shown.messages[0]!.issuer).toEqual({ role: 'foreman', name: 'coordinator' })
    expect(shown.messages[1]!.issuer).toBeUndefined()
  })

  it("leaves an unissued user turn as the human's, which is what absent means", () => {
    const shown = conversationOf(defaultDwarf({ conversation: HELD }))
    expect(shown.messages.map((message) => message.from)).toEqual(['user', 'agent'])
    expect(shown.messages[0]!.issuer).toBeUndefined()
  })
})

describe('authorOf', () => {
  const dwarf = defaultDwarf({ role: 'worker', name: 'survey the seam' })

  it('answers with the issuer when one was named', () => {
    const issuer = { role: 'foreman' as const, name: 'coordinator' }
    expect(authorOf({ from: 'agent', text: 'x', key: 'k', issuer }, dwarf)).toEqual(issuer)
  })

  it('answers with the dwarf itself when nobody else was named', () => {
    expect(authorOf({ from: 'agent', text: 'x', key: 'k' }, dwarf)).toEqual({
      role: 'worker',
      name: 'survey the seam'
    })
  })
})

describe('latestText', () => {
  it('answers with the last message, which is what the panel sizes itself from', () => {
    expect(latestText(conversationOf(defaultDwarf({ conversation: HELD })))).toBe('Found the seam.')
  })

  it('answers with nothing when nothing was said', () => {
    expect(latestText(conversationOf(defaultDwarf()))).toBe('')
  })

  /**
   * #294 folds consecutive activity rows into a disclosure row with a label of
   * its own ("Working...", "12 steps — ..."). That label is a rendering, and
   * this function answers with the panel's own MESSAGES: the height the panel
   * opens at derives from what was actually said or done, never from a caption
   * describing it.
   */
  it('answers with a row of the conversation, never a group label the panel drew over it', () => {
    const ending = conversationOf(defaultDwarf(), {
      readable: true,
      messages: [
        { role: 'assistant', text: 'Found the seam.', timestamp: 't0' },
        {
          role: 'assistant',
          text: 'Ran pnpm test',
          timestamp: 't1',
          activity: { kind: 'run', target: 'pnpm test' }
        }
      ]
    })
    expect(latestText(ending)).toBe('Ran pnpm test')
  })
})

/**
 * The one status that means the session behind a dwarf is over (#192), asked
 * by the note above and by #294's activity disclosure.
 */
describe('conversationEnded', () => {
  it('says a leaving dwarf has nothing further to say', () => {
    expect(conversationEnded(defaultDwarf({ status: 'leaving' }))).toBe(true)
  })

  it('says every other status may still say something next poll', () => {
    const live: DwarfStatus[] = ['working', 'waiting']
    for (const status of live) {
      expect(conversationEnded(defaultDwarf({ status }))).toBe(false)
    }
  })
})
