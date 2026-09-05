import { describe, expect, it } from 'vitest'
import { MINE_HISTORY_MESSAGE_LIMIT, type FeedMessage, type MineHistorySpeaker } from '../../types'
import {
  HISTORY_EMPTY_NOTE,
  HISTORY_READING_NOTE,
  HISTORY_TRUNCATED_NOTE,
  HISTORY_UNREADABLE_NOTE,
  formatHistoryTimestamp,
  historyNote,
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

describe('formatHistoryTimestamp', () => {
  /*
   * `Month DD, YYYY HH:MM` is the design's format; local time, zero padding
   * and the full English month name are the defaults #192 settled. Built from
   * local-time components so the expectation holds on any host's zone.
   */
  it('spells the design format with a zero-padded day, hour and minute', () => {
    expect(formatHistoryTimestamp(new Date(2026, 8, 4, 9, 5).getTime())).toBe(
      'September 04, 2026 09:05'
    )
  })

  it('uses the full English month name and a 24-hour clock', () => {
    expect(formatHistoryTimestamp(new Date(2025, 11, 25, 23, 59).getTime())).toBe(
      'December 25, 2025 23:59'
    )
  })

  it('prints nothing for a time that is not one', () => {
    expect(formatHistoryTimestamp(Number.NaN)).toBe('')
  })
})

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

  it('says nobody has spoken yet, in one line, for a readable mine with no speakers', () => {
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
