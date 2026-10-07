// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DwarfId, FeedPage, IpcResult, MessageId, MessageView } from '@dwarfai/contracts'
import {
  CONVERSATION_START_NOTE,
  READING_OLDER_NOTE,
  joinFeedPages
} from '../lib/message/feedPages'
import { useDwarfPaging, type HostFeedPageRead } from './useDwarfPaging'

/**
 * #364: the pages of conversation older than the newest feed, held for the
 * dwarf the panel has open.
 *
 * What the seam between two pages looks like is `lib/message/feedPages`'s and
 * is pinned there; this file is about WHEN a page is asked for, which answer is
 * kept, and what survives a push, a re-read and a switch.
 *
 * AMENDED for ISSUE-123: the helpers of today's paging (`said`, `ran`, `before`, `stubApi`, `PAGE`) went with it; the
 * cases below build Host pages instead.
 */

/** Resolves only when `release()` is called, so an in-flight read can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/*
 * AMENDED for ISSUE-123 (was: every case over today's `older`, A-15 in today's shape through `window.api`): the cut-1
 * switch routes A-15 `host` with its target shape and retires today's paging (14 §6.4 row `useDwarfPaging`), so each
 * case below states the same rule over `olderFromHost`, the one scroll-back left, with the Host read injected. The
 * cursor is the oldest Host row held (`tailOldest` before the first page). Four cases went with today's transcript
 * walk, stated in docs/test-removals.md: "asks for the page before the oldest thing said, never before a tool call"
 * (the cursor is a `MessageId` now, never a row's words), "says a conversation cannot be paged in its own words, never
 * as a beginning", "says the transcript outran the read, and stops asking, when the page is beyond reach" and
 * "forgets a wall it hit when the panel moves on, so the next dwarf may page" (the Host's log has at most 50 rows per
 * dwarf, PO #87: no page is unreadable or beyond reach). The Host-shape cases at the end of this file pin the request.
 */
describe('useDwarfPaging', () => {
  const S1 = '01920000-0000-7000-8000-00000000d001' as DwarfId
  const S2 = '01920000-0000-7000-8000-00000000d002' as DwarfId
  const row = (n: number) =>
    `01920000-0000-7000-8000-00000000f${String(n).padStart(3, '0')}` as MessageId
  /** 2026-10-06T09:00:00.000Z, in epoch ms. */
  const NINE = 1_791_277_200_000

  function view(n: number, text: string): MessageView {
    return {
      id: row(n),
      dwarfId: S1,
      role: 'dwarf',
      text,
      attachments: [],
      providerTime: null,
      createdAt: NINE + n * 60_000
    }
  }
  const atMinute = (n: number) => new Date(NINE + n * 60_000).toISOString()

  function page(messages: MessageView[], reachedStart: boolean): IpcResult<FeedPage> {
    return { ok: true, value: { dwarfId: S1, messages, reachedStart } }
  }
  const PAGE = page([view(0, 'the first thing')], false)

  function stubRead(answer: HostFeedPageRead) {
    return vi.fn<HostFeedPageRead>(answer)
  }

  beforeEach(() => {
    useDwarfPaging().clear()
  })

  it('asks for nothing at all when the panel holds no words to page before', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, null, read)

    expect(read).not.toHaveBeenCalled()
  })

  it('keeps the page it was given, and says nothing more about the reading', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost, state, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    expect(state.pages).toEqual([
      [{ role: 'assistant', text: 'the first thing', timestamp: atMinute(0) }]
    ])
    expect(note.value).toBeNull()
  })

  it('says a read is under way while one is in flight, in the panel’s own register', async () => {
    const pending = deferred<IpcResult<FeedPage>>()
    const read = stubRead(() => pending.promise)
    const { hold, olderFromHost, note } = useDwarfPaging()

    hold(S1)
    const reading = olderFromHost(S1, row(1), read)
    expect(note.value).toBe(READING_OLDER_NOTE)

    pending.release(PAGE)
    await reading
    expect(note.value).toBeNull()
  })

  it('holds one read at a time, so a second scroll cannot double the request', async () => {
    const pending = deferred<IpcResult<FeedPage>>()
    const read = stubRead(() => pending.promise)
    const { hold, olderFromHost } = useDwarfPaging()

    hold(S1)
    const first = olderFromHost(S1, row(1), read)
    await olderFromHost(S1, row(1), read)

    expect(read).toHaveBeenCalledTimes(1)
    pending.release(PAGE)
    await first
  })

  it('stacks a second page above the first, oldest at the top', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    read.mockResolvedValueOnce(page([view(1, 'the second thing')], false))
    read.mockResolvedValueOnce(page([view(0, 'the first thing')], false))
    const { hold, olderFromHost, state } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(2), read)
    await olderFromHost(S1, row(2), read)

    const newest = [{ role: 'assistant' as const, text: 'halfway down', timestamp: atMinute(2) }]
    expect(joinFeedPages(state.pages, newest).map((message) => message.text)).toEqual([
      'the first thing',
      'the second thing',
      'halfway down'
    ])
  })

  it('drops an answer for the dwarf the panel has since left', async () => {
    const pending = deferred<IpcResult<FeedPage>>()
    const read = stubRead(() => pending.promise)
    const { hold, olderFromHost, state } = useDwarfPaging()

    hold(S1)
    const reading = olderFromHost(S1, row(1), read)
    hold(S2)

    pending.release(PAGE)
    await reading

    // The page belongs to a conversation nobody is looking at any more, and
    // landing it here would draw one dwarf's words under another's name.
    expect(state.dwarfId).toBe(S2)
    expect(state.pages).toEqual([])
  })

  it('refuses a request for a dwarf it is not holding pages for', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S2, row(1), read)

    expect(read).not.toHaveBeenCalled()
  })

  it('says the conversation has a beginning, once, and then stops asking', async () => {
    const read = stubRead(() => Promise.resolve(page([view(0, 'the first thing ever')], true)))
    const { hold, olderFromHost, state, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    expect(state.pages.map((rows) => rows.map((message) => message.text))).toEqual([
      ['the first thing ever']
    ])
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    await olderFromHost(S1, row(1), read)

    expect(read).toHaveBeenCalledTimes(1)
    expect(note.value).toBe(CONVERSATION_START_NOTE)
  })

  it('takes a last page that came back empty, and still says the start was reached', async () => {
    // The Host answers empty with reachedStart when the cursor was the log's own oldest row: there is nothing older,
    // and saying so is what stops the asking.
    const read = stubRead(() => Promise.resolve(page([], true)))
    const { hold, olderFromHost, state, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    expect(state.pages).toEqual([])
    expect(note.value).toBe(CONVERSATION_START_NOTE)
  })

  it('keeps asking after a SHORT page, which is a page and not a wall', async () => {
    // Non-empty with reachedStart false is the ordinary middle of a walk: rows came back and there is more behind them.
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    expect(note.value).toBeNull()

    await olderFromHost(S1, row(1), read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('claims nothing when the bridge itself failed, and lets the reader ask again', async () => {
    const read = stubRead(() => Promise.reject(new Error('no bridge')))
    const { hold, olderFromHost, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    // A lost round trip says nothing about the conversation: it is not at its start, so the next scroll tries again.
    expect(note.value).toBeNull()
    await olderFromHost(S1, row(1), read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost, state } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)
    expect(state.pages).toHaveLength(1)

    hold(S2)

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBe(S2)
  })

  it('throws them away when the panel goes to nobody, which a held session also does', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost, state } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    hold(null)

    expect(state.pages).toEqual([])
    expect(state.dwarfId).toBeNull()
  })

  it('keeps every page through a re-read of the SAME dwarf', async () => {
    const read = stubRead(() => Promise.resolve(PAGE))
    const { hold, olderFromHost, state } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)

    // Every frame for this dwarf holds the same dwarf again; four pages of scrollback must not be the price of the
    // session saying one more thing (#196).
    hold(S1)

    expect(state.pages.map((rows) => rows.map((message) => message.text))).toEqual([
      ['the first thing']
    ])
  })

  it('forgets the start it reached when the panel moves on, so the next dwarf may page', async () => {
    const read = stubRead(() => Promise.resolve(page([], true)))
    const { hold, olderFromHost, note } = useDwarfPaging()

    hold(S1)
    await olderFromHost(S1, row(1), read)
    expect(note.value).toBe(CONVERSATION_START_NOTE)

    hold(S2)

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
