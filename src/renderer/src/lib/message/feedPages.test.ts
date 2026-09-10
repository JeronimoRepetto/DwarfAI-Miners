import { describe, expect, it } from 'vitest'
import {
  BEYOND_REACH_NOTE,
  CONVERSATION_START_NOTE,
  NO_OLDER_PAGES_NOTE,
  READING_OLDER_NOTE,
  feedPageCursorOf,
  joinFeedPages,
  pagingNoteOf
} from './feedPages'
import type { FeedMessage } from '../../types'

/**
 * #364: the panel holds the newest page and every OLDER page it has fetched,
 * and these are the decisions that join them — which row a page is asked for
 * (the oldest thing SAID, never a tool call), what the seam between two pages
 * looks like once the read has repeated a row, and the one line the panel says
 * about the reading itself.
 */

function said(text: string, timestamp: string): FeedMessage {
  return { role: 'assistant', text, timestamp }
}

function ran(text: string, timestamp: string): FeedMessage {
  return { role: 'assistant', text, timestamp, activity: { kind: 'run', target: text } }
}

describe('feedPageCursorOf', () => {
  it('names the oldest thing said, which is where the page before it starts', () => {
    expect(feedPageCursorOf([said('first', 't1'), said('second', 't2')])).toEqual({
      timestamp: 't1',
      text: 'first'
    })
  })

  it('skips a tool-call row above it: a page is measured in things said', () => {
    // The wire says the same thing (see FeedPageCursor): a cursor naming a
    // tool-call line would anchor the next page in the middle of a run.
    expect(feedPageCursorOf([ran('Ran npm test', 't0'), said('first', 't1')])).toEqual({
      timestamp: 't1',
      text: 'first'
    })
  })

  it('names nothing for a list that holds only work', () => {
    expect(feedPageCursorOf([ran('Ran npm test', 't0')])).toBeNull()
  })

  it('names nothing for an empty list, so there is nothing to ask for', () => {
    expect(feedPageCursorOf([])).toBeNull()
  })

  it('keeps an empty timestamp, which is a real value a cursor has to survive', () => {
    // An extractor falls back to '' for a record that carried none, and main
    // refuses to coerce it (see parseDwarfFeedPageRequest).
    expect(feedPageCursorOf([said('first', '')])).toEqual({ timestamp: '', text: 'first' })
  })
})

describe('joinFeedPages', () => {
  it('draws the newest page alone while nothing older has been fetched', () => {
    const newest = [said('first', 't1'), said('second', 't2')]
    expect(joinFeedPages([], newest)).toEqual(newest)
  })

  it('puts an older page above the newest one, oldest first', () => {
    const older = [said('older', 't0')]
    const newest = [said('first', 't1')]
    expect(joinFeedPages([older], newest)).toEqual([said('older', 't0'), said('first', 't1')])
  })

  it('joins several pages in the order they were fetched, oldest at the top', () => {
    expect(joinFeedPages([[said('a', 't0')], [said('b', 't1')]], [said('c', 't2')])).toEqual([
      said('a', 't0'),
      said('b', 't1'),
      said('c', 't2')
    ])
  })

  it('draws a repeated row once, so a collision does not double the seam', () => {
    // The documented cost of a content cursor: two rows equal in text and
    // timestamp resolve to the NEWER one, so the page comes back carrying the
    // reader's own oldest row again (see FeedPageCursor in contracts.ts).
    const older = [said('older', 't0'), said('yes', 't1')]
    const newest = [said('yes', 't1'), said('after', 't2')]
    expect(joinFeedPages([older], newest)).toEqual([
      said('older', 't0'),
      said('yes', 't1'),
      said('after', 't2')
    ])
  })

  it('drops the whole repeated run, not only its last row', () => {
    // A page ends at the row before the collision, so it carries the cursor row
    // AND the tool calls that followed it — every one of them already on screen.
    const older = [said('older', 't0'), said('yes', 't1'), ran('Ran npm test', 't1')]
    const newest = [said('yes', 't1'), ran('Ran npm test', 't1'), said('after', 't2')]
    expect(joinFeedPages([older], newest)).toEqual([
      said('older', 't0'),
      said('yes', 't1'),
      ran('Ran npm test', 't1'),
      said('after', 't2')
    ])
  })

  it('keeps two genuinely repeated words apart when they are not at the seam', () => {
    // The same word said twice inside one page is conversation, not a repeat:
    // only the join between two pages is ever deduped.
    const newest = [said('yes', 't1'), said('yes', 't2')]
    expect(joinFeedPages([], newest)).toEqual(newest)
  })

  it('keeps an older page whose newest row merely resembles the seam', () => {
    // Same text, different timestamp: two different things said, and dropping
    // one would leave a gap — the direction the wire refuses to be wrong in.
    const older = [said('yes', 't0')]
    const newest = [said('yes', 't1')]
    expect(joinFeedPages([older], newest)).toEqual([said('yes', 't0'), said('yes', 't1')])
  })

  it('drops an older page that repeated the seam entirely', () => {
    const older = [said('yes', 't1')]
    const newest = [said('yes', 't1')]
    expect(joinFeedPages([older], newest)).toEqual([said('yes', 't1')])
  })
})

describe('pagingNoteOf', () => {
  const NOTHING_ASKED = {
    loading: false,
    reachedStart: false,
    unpageable: false,
    beyondReach: false
  }

  it('says nothing at all while the reader has asked for nothing', () => {
    expect(pagingNoteOf(NOTHING_ASKED)).toBeNull()
  })

  it('says a read is under way while one is in flight', () => {
    expect(pagingNoteOf({ ...NOTHING_ASKED, loading: true })).toBe(READING_OLDER_NOTE)
  })

  it('says the conversation has a beginning once the last page came back', () => {
    expect(pagingNoteOf({ ...NOTHING_ASKED, reachedStart: true })).toBe(CONVERSATION_START_NOTE)
  })

  it('says a conversation cannot be paged at all, which is not the same as reaching its start', () => {
    expect(pagingNoteOf({ ...NOTHING_ASKED, unpageable: true })).toBe(NO_OLDER_PAGES_NOTE)
  })

  it('says the transcript outran the read when the page came back beyond reach', () => {
    // The window walk stops at FEED_WINDOW_CEILING_BYTES. Past that the file
    // goes on and the read cannot follow it, which is neither the start of the
    // conversation nor a transcript that cannot be paged.
    expect(pagingNoteOf({ ...NOTHING_ASKED, beyondReach: true })).toBe(BEYOND_REACH_NOTE)
  })

  it('says what is happening now over what already happened', () => {
    expect(pagingNoteOf({ ...NOTHING_ASKED, loading: true, reachedStart: true })).toBe(
      READING_OLDER_NOTE
    )
  })

  it('keeps out of reach apart from the start, which it must never be read as', () => {
    // Belt and braces: the composable never sets both, and if it ever did, the
    // claim that must not slip out is "you have seen the beginning".
    expect(pagingNoteOf({ ...NOTHING_ASKED, beyondReach: true, reachedStart: true })).toBe(
      BEYOND_REACH_NOTE
    )
  })
})
