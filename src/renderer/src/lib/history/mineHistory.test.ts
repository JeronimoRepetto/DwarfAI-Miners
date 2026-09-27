import { describe, expect, it } from 'vitest'
import { MINE_HISTORY_MESSAGE_LIMIT, type FeedMessage, type MineHistorySpeaker } from '../../types'
import {
  HISTORY_EMPTY_NOTE,
  HISTORY_READING_NOTE,
  HISTORY_TRUNCATED_NOTE,
  HISTORY_READ_ONLY_NOTE,
  HISTORY_UNREADABLE_NOTE,
  historyClock,
  historyLabel,
  historyMarks,
  historyNote,
  historyTabLast,
  historyTabs,
  historyTitle,
  latestMessages,
  orderSpeakers,
  selectedSpeakerId,
  speakerHistoryNotice,
  speakerRows
} from './mineHistory'

/*
 * The Mine History panel's decisions (#192), kept out of the component: which
 * tab comes first, how many messages a tab shows, how the timestamp is spelled,
 * and whose face a row wears. `screens/history.md` fixes the first three; the
 * defaults the design leaves Unspecified are the ones #192's maintainer comment
 * settled, and each is named where it is pinned.
 */

function speaker(overrides: Partial<MineHistorySpeaker> = {}): MineHistorySpeaker {
  return {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    lastMessageAt: 1_000,
    messages: [{ role: 'assistant', text: 'Found the seam.', timestamp: '2026-09-01T10:00:00Z' }],
    ...overrides
  }
}

describe('orderSpeakers', () => {
  it('puts the dwarf that spoke most recently first', () => {
    const ordered = orderSpeakers([
      speaker({ id: 'old', lastMessageAt: 1_000 }),
      speaker({ id: 'newest', lastMessageAt: 3_000 }),
      speaker({ id: 'middle', lastMessageAt: 2_000 })
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['newest', 'middle', 'old'])
  })

  it('breaks a tie on id, so two dwarfs silent at the same instant keep one order', () => {
    const ordered = orderSpeakers([
      speaker({ id: 'claude:b', lastMessageAt: 1_000 }),
      speaker({ id: 'claude:a', lastMessageAt: 1_000 })
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['claude:a', 'claude:b'])
  })

  it('leaves the wire list itself untouched', () => {
    const wire = [
      speaker({ id: 'old', lastMessageAt: 1 }),
      speaker({ id: 'new', lastMessageAt: 2 })
    ]
    orderSpeakers(wire)
    expect(wire.map((entry) => entry.id)).toEqual(['old', 'new'])
  })
})

describe('latestMessages', () => {
  function replies(count: number): FeedMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      role: 'assistant' as const,
      text: `reply ${index}`,
      timestamp: ''
    }))
  }

  it('keeps the newest MINE_HISTORY_MESSAGE_LIMIT messages, oldest first', () => {
    const kept = latestMessages(replies(MINE_HISTORY_MESSAGE_LIMIT + 3))
    expect(kept).toHaveLength(MINE_HISTORY_MESSAGE_LIMIT)
    expect(kept[0]?.text).toBe('reply 3')
    expect(kept.at(-1)?.text).toBe(`reply ${MINE_HISTORY_MESSAGE_LIMIT + 2}`)
  })

  it('returns a shorter transcript whole', () => {
    expect(latestMessages(replies(4))).toHaveLength(4)
  })
})

describe('selectedSpeakerId', () => {
  const ordered = [speaker({ id: 'newest' }), speaker({ id: 'older' })]

  it('opens on the newest tab when nothing is selected yet', () => {
    // The design leaves the default Unspecified; #192 settles it as the newest.
    expect(selectedSpeakerId(ordered, null)).toBe('newest')
  })

  it('keeps the tab the person chose while it still exists, whatever a re-read did to the order', () => {
    expect(selectedSpeakerId(ordered, 'older')).toBe('older')
  })

  it('falls back to the newest when the chosen tab is gone', () => {
    expect(selectedSpeakerId(ordered, 'vanished')).toBe('newest')
  })

  it('selects nothing when nobody has spoken', () => {
    expect(selectedSpeakerId([], 'anything')).toBeNull()
  })
})

/*
 * REMOVED for #635, stated rather than passing unseen: `formatHistoryTimestamp` and its three
 * tests (the `Month DD, YYYY HH:MM` spelling, the full English month on a 24-hour clock, nothing
 * for a time that is not one). The redesigned history prints no footer timestamp; each tab says
 * "last · HH:MM" and each bubble its own time, which `historyClock` below spells and pins.
 */

describe('speakerRows', () => {
  it("draws the dwarf's own words as agent rows under its own face", () => {
    const rows = speakerRows(speaker({ role: 'worker2', name: 'Check the map' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      from: 'agent',
      text: 'Found the seam.',
      author: { role: 'worker2', name: 'Check the map' }
    })
  })

  it("draws a human's prompt as a user row", () => {
    const rows = speakerRows(
      speaker({
        messages: [{ role: 'user', text: 'dig here', timestamp: '2026-09-01T09:00:00Z' }]
      })
    )
    expect(rows[0]).toMatchObject({ from: 'user', text: 'dig here' })
  })

  it('draws a prompt another agent issued as that agent, not as the human and not as this dwarf (#175)', () => {
    const rows = speakerRows(
      speaker({
        role: 'worker',
        name: 'Map the seam',
        messages: [
          {
            role: 'user',
            text: 'Map the seam.',
            timestamp: '2026-09-01T09:00:00Z',
            issuer: { role: 'foreman', name: '5efdffdd' }
          }
        ]
      })
    )
    expect(rows[0]).toMatchObject({
      from: 'agent',
      author: { role: 'foreman', name: '5efdffdd' }
    })
  })

  it('trims to the latest MINE_HISTORY_MESSAGE_LIMIT even if the wire carried more', () => {
    const messages: FeedMessage[] = Array.from({ length: MINE_HISTORY_MESSAGE_LIMIT + 1 }, () => ({
      role: 'assistant',
      text: 'x',
      timestamp: ''
    }))
    expect(speakerRows(speaker({ messages }))).toHaveLength(MINE_HISTORY_MESSAGE_LIMIT)
  })

  it('gives every row a distinct key', () => {
    const rows = speakerRows(
      speaker({
        messages: [
          { role: 'assistant', text: 'a', timestamp: 't' },
          { role: 'assistant', text: 'a', timestamp: 't' }
        ]
      })
    )
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })
})

describe('historyNote', () => {
  it('says the read is still in flight while nothing has come back', () => {
    expect(historyNote(undefined)).toBe(HISTORY_READING_NOTE)
  })

  it('says the mine could not be read, which is not "nobody has spoken"', () => {
    expect(historyNote({ readable: false, speakers: [] })).toBe(HISTORY_UNREADABLE_NOTE)
  })

  // AMENDED for #635: the copy is the design's "Nobody has worked here yet." (screens/mine.md).
  it('says nobody has spoken yet, in one line, for a readable mine with no speakers', () => {
    expect(HISTORY_EMPTY_NOTE).toBe('Nobody has worked here yet.')
    expect(historyNote({ readable: true, speakers: [] })).toBe(HISTORY_EMPTY_NOTE)
    expect(HISTORY_EMPTY_NOTE.split('\n')).toHaveLength(1)
  })

  it('has nothing to say once there is a transcript to show', () => {
    expect(historyNote({ readable: true, speakers: [speaker()] })).toBeNull()
  })
})

/*
 * #227: `screens/history.md` never asked for this notice — the design source
 * is silent on it (see `skills/ui-rebuild/SKILL.md`) — so both the placement
 * (top of the tab, in MineHistoryPanel.vue) and this copy are the issue's own,
 * the way `panelHeight.ts` names the constants the design left it to invent.
 * Absent means unknown and unknown says nothing, exactly like a known `true`:
 * only a known `false` is worth admitting to the person reading the tab.
 */
describe('speakerHistoryNotice', () => {
  it('says nothing for a speaker whose read reached the start of its transcript', () => {
    expect(speakerHistoryNotice(speaker({ reachedStart: true }))).toBeNull()
  })

  it('says nothing when the flag is absent, since absent means unknown', () => {
    expect(speakerHistoryNotice(speaker())).toBeNull()
  })

  it('says nothing when there is no selected speaker at all', () => {
    expect(speakerHistoryNotice(undefined)).toBeNull()
  })

  it('admits the tab does not reach the start when the read stopped short of it', () => {
    expect(speakerHistoryNotice(speaker({ reachedStart: false }))).toBe(HISTORY_TRUNCATED_NOTE)
    expect(HISTORY_TRUNCATED_NOTE.split('\n')).toHaveLength(1)
  })
})

describe('historyClock', () => {
  // Local time, zero-padded, 24-hour: built from local components so it holds in any zone.
  it('spells a time as HH:MM, local and zero-padded', () => {
    expect(historyClock(new Date(2026, 8, 4, 9, 5).getTime())).toBe('09:05')
    expect(historyClock(new Date(2025, 11, 25, 23, 59).getTime())).toBe('23:59')
  })

  it('prints nothing for a time that is not one', () => {
    expect(historyClock(Number.NaN)).toBe('')
  })
})

describe('the history copy', () => {
  it('titles the panel "History · <mine>" and names it "Mine history, <mine>"', () => {
    expect(historyTitle('DwarfAI-Miners')).toBe('History · DwarfAI-Miners')
    expect(historyLabel('DwarfAI-Miners')).toBe('Mine history, DwarfAI-Miners')
  })

  // The cap it states is the one the wire is held to, not a second copy of the number.
  it('states the read-only cap from the limit the wire keeps', () => {
    expect(HISTORY_READ_ONLY_NOTE).toBe(
      'Read-only · up to the last ' + MINE_HISTORY_MESSAGE_LIMIT + ' messages'
    )
  })

  it('tells each tab its last message time, or "no messages"', () => {
    const at = new Date(2026, 8, 4, 9, 8).getTime()
    expect(historyTabLast(speaker({ lastMessageAt: at }))).toBe('last · 09:08')
    expect(historyTabLast(speaker({ messages: [] }))).toBe('no messages')
  })
})

describe('historyTabs', () => {
  /*
   * One tab per dwarf (components.md, Mine history), in the order the mine's roster draws its
   * crew, so a dwarf is in the same place in both; a dwarf that has left the mine follows, newest
   * first, as the tabs were ordered before #635.
   */
  it('puts the crew first in roster order, then former dwarfs newest first', () => {
    const tabs = historyTabs(
      [
        speaker({ id: 'gone-old', lastMessageAt: 1 }),
        speaker({ id: 'd56', lastMessageAt: 9 }),
        speaker({ id: 'gone-new', lastMessageAt: 5 }),
        speaker({ id: 'd53', lastMessageAt: 2 })
      ],
      ['d53', 'd54', 'd56']
    )
    expect(tabs.map((t) => t.id)).toEqual(['d53', 'd56', 'gone-new', 'gone-old'])
  })
})

describe('historyMarks', () => {
  /*
   * Delivered and reacted are different facts (AGENTS.md, reaction.ts). A prompt in the
   * transcript was handed to the session, so it is at least ✓; it is ✓✓ only when the session
   * was seen acting after it — a later turn of its own, spoken or a step. Never a mark on the
   * dwarf's own words, and nothing is claimed for a prompt the transcript does not hold.
   */
  it('marks a prompt the session answered ✓✓ and one still unanswered ✓', () => {
    const rows = speakerRows(
      speaker({
        messages: [
          { role: 'user', text: 'Refuse the guess.', timestamp: 't1' },
          {
            role: 'assistant',
            text: 'Read ledger.ts',
            timestamp: 't2',
            activity: { kind: 'read', target: 'ledger.ts' }
          },
          { role: 'assistant', text: 'Done.', timestamp: 't3' },
          { role: 'user', text: 'Open a PR.', timestamp: 't4' }
        ]
      })
    )
    expect(historyMarks(rows)).toEqual(['reacted', undefined, undefined, 'delivered'])
  })

  it('does not count a prompt another agent issued as the session acting', () => {
    const rows = speakerRows(
      speaker({
        messages: [
          { role: 'user', text: 'Go.', timestamp: 't1' },
          { role: 'user', text: 'Map it.', timestamp: 't2', issuer: { role: 'foreman', name: 'f' } }
        ]
      })
    )
    expect(historyMarks(rows)[0]).toBe('delivered')
  })
})

describe('speakerRows, each with its time', () => {
  it('carries each message’s own time as HH:MM', () => {
    const timestamp = new Date(2026, 8, 4, 9, 2).toISOString()
    const rows = speakerRows(speaker({ messages: [{ role: 'user', text: 'x', timestamp }] }))
    expect(rows[0]!.time).toBe('09:02')
  })
})
