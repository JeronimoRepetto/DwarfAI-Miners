// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DwarfId, FeedPage, IpcResult, MessageId, MessageView } from '@dwarfai/contracts'
import {
  BEYOND_REACH_NOTE,
  CONVERSATION_START_NOTE,
  NO_OLDER_PAGES_NOTE,
  READING_OLDER_NOTE,
  feedPageCursorOf,
  joinFeedPages
} from '../lib/message/feedPages'
import type { DwarfFeedPage, FeedMessage, FeedPageCursor } from '../types'
import { useDwarfPaging, type HostFeedPageRead } from './useDwarfPaging'

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

/**
 * ADDED for #430. `older` now takes the CURSOR the panel decided on rather than
 * the rows it is drawing: WHICH row a conversation hangs its next page off is a
 * different question for a held session than for an observed one
 * (`heldFeedPageCursorOf`), and that decision belongs to `lib/message/feedPages`
 * where it is pinned.
 *
 * Every case below still states the rows it is about and derives the cursor
 * exactly as the panel does for an observed session, so what each one asserts
 * is unchanged — including the first two, which are about a store that forwards
 * a cursor it was given and refuses a null one.
 */
function before(shown: readonly FeedMessage[]): FeedPageCursor | null {
  return feedPageCursorOf(shown)
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
    await older('claude:s1', before([ran('Ran npm test', 't0'), said('halfway down', 't1')]))

    expect(api).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't1', text: 'halfway down' }
    })
  })

  it('asks for nothing at all when the panel holds no words to page before', async () => {
    const api = stubApi(() => Promise.resolve(PAGE))
    const { hold, older } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([ran('Ran npm test', 't0')]))

    expect(api).not.toHaveBeenCalled()
  })

  it('keeps the page it was given, and says nothing more about the reading', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(state.pages).toEqual([[said('the first thing', 't0')]])
    expect(note.value).toBeNull()
  })

  it('says a read is under way while one is in flight, in the panel’s own register', async () => {
    const pending = deferred<DwarfFeedPage>()
    stubApi(() => pending.promise)
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    const reading = older('claude:s1', before([said('halfway down', 't1')]))
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
    const first = older('claude:s1', before([said('halfway down', 't1')]))
    await older('claude:s1', before([said('halfway down', 't1')]))

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
    await older('claude:s1', before([said('halfway down', 't2')]))
    await older('claude:s1', before([said('the second thing', 't1'), said('halfway down', 't2')]))

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
    const reading = older('claude:s1', before([said('halfway down', 't1')]))
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
    await older('claude:s2', before([said('halfway down', 't1')]))

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
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(state.pages).toEqual([[said('the first thing ever', 't0')]])
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    await older(
      'claude:s1',
      before([said('the first thing ever', 't0'), said('halfway down', 't1')])
    )

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
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(state.pages).toEqual([])
    expect(note.value).toBe(CONVERSATION_START_NOTE)
  })

  it('says a conversation cannot be paged in its own words, never as a beginning', async () => {
    const api = stubApi(() =>
      Promise.resolve({ readable: false, messages: [], reachedStart: false })
    )
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(note.value).toBe(NO_OLDER_PAGES_NOTE)
    // Unreadable is not the start: there is nothing left to ask, so it stops
    // asking, but it must not claim the transcript was read back to its first
    // line (the distinction DwarfFeedPage draws).
    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('says the transcript outran the read, and stops asking, when the page is beyond reach', async () => {
    // Empty and NOT the start is the one answer `readFeedPage` gives when its
    // widest window filled and the cursor was not in it: the file goes on past
    // FEED_WINDOW_CEILING_BYTES and the walk stopped there. Asking again would
    // read the same 8 MiB and answer the same nothing, so it stops — and it
    // must never be reported as the beginning of the conversation.
    const api = stubApi(() =>
      Promise.resolve({ readable: true, messages: [], reachedStart: false })
    )
    const { hold, older, state, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(note.value).toBe(BEYOND_REACH_NOTE)
    expect(state.pages).toEqual([])
    expect(state.reachedStart).toBe(false)

    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('keeps asking after a SHORT page, which is a page and not a wall', async () => {
    // Non-empty with reachedStart false is the ordinary middle of a walk: rows
    // came back and there is more behind them. Only an EMPTY one at the ceiling
    // means the read cannot go further.
    const api = stubApi(() => Promise.resolve(PAGE))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    expect(note.value).toBeNull()

    await older('claude:s1', before([said('the first thing', 't0'), said('halfway down', 't1')]))
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('forgets a wall it hit when the panel moves on, so the next dwarf may page', async () => {
    stubApi(() => Promise.resolve({ readable: true, messages: [], reachedStart: false }))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(note.value).toBe(BEYOND_REACH_NOTE)

    hold('claude:s2')

    expect(note.value).toBeNull()
  })

  it('claims nothing when the bridge itself failed, and lets the reader ask again', async () => {
    const api = stubApi(() => Promise.reject(new Error('no bridge')))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    // A lost round trip says nothing about the transcript: it is neither
    // unpageable nor at its start, so the next scroll tries again.
    expect(note.value).toBeNull()
    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(state.pages).toHaveLength(1)

    hold('claude:s2')

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBe('claude:s2')
  })

  it('throws them away when the panel goes to nobody, which a held session also does', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    hold(null)

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBeNull()
  })

  it('keeps every page through a re-read of the SAME dwarf', async () => {
    stubApi(() => Promise.resolve(PAGE))
    const { hold, older, state } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))

    // The poll re-reads on every sign of activity; four pages of scrollback
    // must not be the price of the session saying one more thing (#196).
    hold('claude:s1')

    expect(state.pages).toEqual([[said('the first thing', 't0')]])
  })

  it('forgets the start it reached when the panel moves on, so the next dwarf may page', async () => {
    stubApi(() => Promise.resolve({ readable: true, messages: [], reachedStart: true }))
    const { hold, older, note } = useDwarfPaging()

    hold('claude:s1')
    await older('claude:s1', before([said('halfway down', 't1')]))
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    hold('claude:s2')

    expect(note.value).toBeNull()
  })
})

/*
 * SCROLL-BACK FROM THE HOST (ISSUE-106; 14 §2.1 row A-15, §3.6, §6.4 row `useDwarfPaging`; ADR-007).
 *
 * A-15 pages the Host's message log in its 14 shape: `FeedParams` `{ dwarfId, page: { before, limit } }`, with
 * `before` the `MessageId` of the oldest row held, answered by `IpcResult<FeedPage>` of `MessageView` rows that the
 * composable maps to today's `FeedMessage`. The call is injected until the cut-1 switch (ISSUE-123) regenerates
 * `window.api` with A-15's target shape; it stands in for `window.api.getDwarfFeedPage`.
 */
describe('useDwarfPaging from the Host', () => {
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
  const id = (n: number) =>
    `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId
  /** 2026-10-06T09:00:00.000Z, in epoch ms. */
  const NINE = 1_791_277_200_000

  function view(n: number): MessageView {
    return {
      id: id(n),
      dwarfId: BORIN,
      role: 'dwarf',
      text: `line ${n}`,
      attachments: [],
      providerTime: null,
      createdAt: NINE + n * 60_000
    }
  }

  function feedPage(messages: MessageView[], reachedStart: boolean): IpcResult<FeedPage> {
    return { ok: true, value: { dwarfId: BORIN, messages, reachedStart } }
  }

  beforeEach(() => {
    useDwarfPaging().clear()
  })

  it('[ADR-007] scrolling back calls getDwarfFeedPage with the 14 FeedParams shape and stops at reachedStart', async () => {
    const getDwarfFeedPage = vi
      .fn<HostFeedPageRead>()
      .mockResolvedValueOnce(feedPage([view(3), view(4)], false))
      .mockResolvedValueOnce(feedPage([view(2)], true))
    const { state, hold, olderFromHost } = useDwarfPaging()

    hold(BORIN)
    await olderFromHost(BORIN, id(5), getDwarfFeedPage)
    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: BORIN,
      page: { before: id(5), limit: 50 }
    })
    expect(state.pages).toEqual([
      [
        { role: 'assistant', text: 'line 3', timestamp: '2026-10-06T09:03:00.000Z' },
        { role: 'assistant', text: 'line 4', timestamp: '2026-10-06T09:04:00.000Z' }
      ]
    ])

    // The next page hangs off the oldest row now held, whatever the tail's oldest was.
    await olderFromHost(BORIN, id(5), getDwarfFeedPage)
    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: BORIN,
      page: { before: id(3), limit: 50 }
    })
    expect(state.pages.map((rows) => rows.map((row) => row.text))).toEqual([
      ['line 2'],
      ['line 3', 'line 4']
    ])
    expect(state.reachedStart).toBe(true)

    await olderFromHost(BORIN, id(5), getDwarfFeedPage)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(2)
  })

  it('[ADR-007] a refused or malformed Host page claims nothing about the conversation', async () => {
    const getDwarfFeedPage = vi
      .fn<HostFeedPageRead>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
      })
      .mockResolvedValueOnce({ readable: true, messages: [], reachedStart: true })
    const { state, hold, olderFromHost } = useDwarfPaging()

    hold(BORIN)
    await olderFromHost(BORIN, id(5), getDwarfFeedPage)
    await olderFromHost(BORIN, id(5), getDwarfFeedPage)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(2)
    expect(state).toMatchObject({
      pages: [],
      loading: false,
      reachedStart: false,
      unpageable: false,
      beyondReach: false
    })
  })
})
