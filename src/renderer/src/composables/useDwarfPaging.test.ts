// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_START_NOTE,
  NO_OLDER_PAGES_NOTE,
  READING_OLDER_NOTE,
  joinFeedPages
} from '../lib/message/feedPages'
import type { DwarfFeedPage, FeedMessage } from '../types'
import { useDwarfPaging } from './useDwarfPaging'

/**
 * #364: the pages of conversation older than the newest feed, held for the
 * dwarf the panel has open.
 *
 * What the seam between two pages looks like is `lib/message/feedPages`'s and
 * is pinned there; this file is about WHEN a page is asked for, which answer is
 * kept, and what survives a push, a re-read and a switch.
 */

function said(text: string, timestamp: string): FeedMessage {
  return { role: 'assistant', text, timestamp }
}

function ran(text: string, timestamp: string): FeedMessage {
  return { role: 'assistant', text, timestamp, activity: { kind: 'run', target: text } }
}

function stubApi(getDwarfFeedPage: (...args: never[]) => Promise<DwarfFeedPage>) {
  const spy = vi.fn(getDwarfFeedPage)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getDwarfFeedPage: spy }
  })
  return spy
}

/** Resolves only when `release()` is called, so an in-flight read can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const PAGE: DwarfFeedPage = {
  readable: true,
  messages: [said('the first thing', 't0')],
  reachedStart: false
}

describe('useDwarfPaging', () => {
  beforeEach(() => {
    useDwarfPaging().clear()
  })

  it('asks for the page before the oldest thing said, never before a tool call', async () => {
    const api = stubApi(() => Promise.resolve(PAGE))
    const { hold, older } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [ran('Ran npm test', 't0'), said('halfway down', 't1')])

    expect(api).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't1', text: 'halfway down' }
    })
  })

  it('asks for nothing at all when the panel holds no words to page before', async () => {
    const api = stubApi(() => Promise.resolve(PAGE))
    const { hold, older } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [ran('Ran npm test', 't0')])

    expect(api).not.toHaveBeenCalled()
  })

  it('keeps the page it was given, and says nothing more about the reading', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    expect(state.pages).toEqual([[said('the first thing', 't0')]])
    expect(note.value).toBeNull()
  })

  it('says a read is under way while one is in flight, in the panel’s own register', async () => {
    const pending = deferred<DwarfFeedPage>()
    stubApi(() => pending.promise)
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    const reading = older('claude:s1', [said('halfway down', 't1')])
    expect(note.value).toBe(READING_OLDER_NOTE)

    pending.release(PAGE)
    await reading
    expect(note.value).toBeNull()
  })

  it('holds one read at a time, so a second scroll cannot double the request', async () => {
    const pending = deferred<DwarfFeedPage>()
    const api = stubApi(() => pending.promise)
    const { hold, older } = useDwarfPaging()

    hold('claude:s1')
    const first = older('claude:s1', [said('halfway down', 't1')])
    await older('claude:s1', [said('halfway down', 't1')])

    expect(api).toHaveBeenCalledTimes(1)
    pending.release(PAGE)
    await first
  })

  it('stacks a second page above the first, oldest at the top', async () => {
    const api = stubApi(() => Promise.resolve(PAGE))
    api.mockResolvedValueOnce({
      readable: true,
      messages: [said('the second thing', 't1')],
      reachedStart: false
    })
    api.mockResolvedValueOnce({
      readable: true,
      messages: [said('the first thing', 't0')],
      reachedStart: false
    })
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't2')])
    await older('claude:s1', [said('the second thing', 't1'), said('halfway down', 't2')])

    expect(joinFeedPages(state.pages, [said('halfway down', 't2')])).toEqual([
      said('the first thing', 't0'),
      said('the second thing', 't1'),
      said('halfway down', 't2')
    ])
  })

  it('drops an answer for the dwarf the panel has since left', async () => {
    const pending = deferred<DwarfFeedPage>()
    stubApi(() => pending.promise)
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    const reading = older('claude:s1', [said('halfway down', 't1')])
    hold('claude:s2')

    pending.release(PAGE)
    await reading

    // The page belongs to a conversation nobody is looking at any more, and
    // landing it here would draw one dwarf's words under another's name.
    expect(state.dwarfId).toBe('claude:s2')
    expect(state.pages).toEqual([])
  })

  it('refuses a request for a dwarf it is not holding pages for', async () => {
    const api = stubApi(() => Promise.resolve(PAGE))
    const { hold, older } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s2', [said('halfway down', 't1')])

    expect(api).not.toHaveBeenCalled()
  })

  it('says the conversation has a beginning, once, and then stops asking', async () => {
    const api = stubApi(() =>
      Promise.resolve({
        readable: true,
        messages: [said('the first thing ever', 't0')],
        reachedStart: true
      })
    )
    const { hold, older, state, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    expect(state.pages).toEqual([[said('the first thing ever', 't0')]])
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    await older('claude:s1', [said('the first thing ever', 't0'), said('halfway down', 't1')])

    expect(api).toHaveBeenCalledTimes(1)
    expect(note.value).toBe(CONVERSATION_START_NOTE)
  })

  it('takes a last page that came back empty, and still says the start was reached', async () => {
    // `readFeedPage` answers empty with reachedStart when the cursor was the
    // transcript's own oldest row — there is nothing older, and saying so is
    // what stops the asking.
    stubApi(() => Promise.resolve({ readable: true, messages: [], reachedStart: true }))
    const { hold, older, state, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    expect(state.pages).toEqual([])
    expect(note.value).toBe(CONVERSATION_START_NOTE)
  })

  it('says a conversation cannot be paged in its own words, never as a beginning', async () => {
    const api = stubApi(() =>
      Promise.resolve({ readable: false, messages: [], reachedStart: false })
    )
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    expect(note.value).toBe(NO_OLDER_PAGES_NOTE)
    // Unreadable is not the start: there is nothing left to ask, so it stops
    // asking, but it must not claim the transcript was read back to its first
    // line (the distinction DwarfFeedPage draws).
    await older('claude:s1', [said('halfway down', 't1')])
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('claims nothing when the bridge itself failed, and lets the reader ask again', async () => {
    const api = stubApi(() => Promise.reject(new Error('no bridge')))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    // A lost round trip says nothing about the transcript: it is neither
    // unpageable nor at its start, so the next scroll tries again.
    expect(note.value).toBeNull()
    await older('claude:s1', [said('halfway down', 't1')])
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])
    expect(state.pages).toHaveLength(1)

    hold('claude:s2')

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBe('claude:s2')
  })

  it('throws them away when the panel goes to nobody, which a held session also does', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    hold(null)

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBeNull()
  })

  it('keeps every page through a re-read of the SAME dwarf', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])

    // The poll re-reads on every sign of activity; four pages of scrollback
    // must not be the price of the session saying one more thing (#196).
    hold('claude:s1')

    expect(state.pages).toEqual([[said('the first thing', 't0')]])
  })

  it('forgets the start it reached when the panel moves on, so the next dwarf may page', async () => {
    stubApi(() => Promise.resolve({ readable: true, messages: [], reachedStart: true }))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', [said('halfway down', 't1')])
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    hold('claude:s2')

    expect(note.value).toBeNull()
  })
})
