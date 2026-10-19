import { computed, reactive } from 'vue'
import { CHANNELS, type DwarfId, type FeedParams, type MessageId } from '@dwarfai/contracts'
import { pagingNoteOf } from '../lib/message/feedPages'
import type { FeedMessage } from '../types'
import { feedMessageOf } from './useDwarfMessaging'

/**
 * The pages of conversation OLDER than the newest feed, for the dwarf the
 * message panel has open (#364).
 *
 * ## Why they are not in the feed
 *
 * `selectedFeed` in useMessageDock is the newest page and nothing else: it
 * is replaced whole by every re-read and by every feed the poll pushes for the
 * watched dwarf (#196), which is exactly the behaviour the panel wants for the
 * end of a live conversation. A reader who has paged back four pages must not
 * lose them the next time the session speaks, so the pages are held here
 * instead and joined to the newest page only for drawing (`joinFeedPages`).
 *
 * That split is also what keeps the #249 shrink warning honest. It fires on a
 * feed with fewer messages than the one it replaces; measured against the drawn
 * conversation it would cry wolf on every ordinary push once the reader had
 * paged back, because twelve pushed rows are fewer than forty-eight held ones.
 * Measured against the newest page — which is all `selectedFeed` ever is — it
 * still means what it meant.
 *
 * ## One read at a time, and a token
 *
 * A page costs a widening walk over a transcript in main, so a reader dragging
 * the scrollbar must not fire one per scroll event: a read in flight refuses
 * the next request, and the answer that lands is checked against a token before
 * it is kept, exactly as `feedToken` already guards the feed itself. A slow page
 * therefore cannot land on a dwarf the panel has since left.
 *
 * Singleton store, module-scope, like `useDwarfMessaging` beside it. One dwarf
 * is open at a time, so the pages are held for one dwarf at a time and a
 * genuine switch — another dwarf, a held session taking over the source, the
 * panel closing — throws them away.
 */

/** A-15 `getDwarfFeedPage` in its 14 shape (`FeedParams` → `IpcResult<FeedPage>`): `window.api.getDwarfFeedPage`. */
export type HostFeedPageRead = (params: FeedParams) => Promise<unknown>

/** Rows asked per Host page: all there can be, as at most 50 exist per dwarf (14 §3.6 `FeedPageRequest`, PO #87). */
const HOST_PAGE_LIMIT = 50

/** A-15's target answer, read with the registry's own schema so a malformed answer is never taken for a page. */
const hostPageAnswer = CHANNELS['dwarf:feed:page'].response

export interface DwarfPagingState {
  /** Which dwarf these pages belong to, or nobody. */
  dwarfId: string | null
  /** The pages fetched for it, OLDEST first — the order they are drawn in. */
  pages: FeedMessage[][]
  /** A page is in flight. */
  loading: boolean
  /** The last page has been fetched: there is nothing older, and nothing left to ask. */
  reachedStart: boolean
  /**
   * This conversation cannot be paged at all (`readable: false`) — a different
   * fact from having reached its start, and it stops the asking without
   * claiming the transcript was read back to its first line.
   */
  unpageable: boolean
  /**
   * The read cannot go back any further, though the conversation does: the
   * transcript outgrew `FEED_WINDOW_CEILING_BYTES` and the walk stopped at it.
   * Stops the asking like `reachedStart`, and says something else entirely —
   * see BEYOND_REACH_NOTE.
   */
  beyondReach: boolean
}

function emptyState(): DwarfPagingState {
  return {
    dwarfId: null,
    pages: [],
    loading: false,
    reachedStart: false,
    unpageable: false,
    beyondReach: false
  }
}

const state = reactive<DwarfPagingState>(emptyState())
/** Which read is the current one, so a slow answer cannot land on a later dwarf. */
let pageToken = 0
/** The oldest Host row a scroll-back page brought, which the next Host page hangs off; null before the first. */
let hostCursor: MessageId | null = null

/** Whose pages these are now, throwing away whatever was held for anybody else. */
function open(dwarfId: string | null): void {
  // Bumped first: a page already in flight belongs to the conversation being
  // left, and its answer has to be refused rather than prepended here.
  pageToken++
  hostCursor = null
  Object.assign(state, emptyState(), { dwarfId })
}

export function useDwarfPaging() {
  /**
   * Hold pages for `dwarfId`, or for nobody.
   *
   * A re-read of the SAME dwarf keeps every page: the poll re-reads on any sign
   * of activity, and losing the scrollback each time would make paging back
   * useless on a busy session. Only a genuine switch clears — which is why this
   * is called from the same places that reset `selectedFeedDwarfId`.
   */
  function hold(dwarfId: string | null): void {
    if (state.dwarfId === dwarfId) return
    open(dwarfId)
  }

  /*
   * REMOVED for ISSUE-123: `older`, today's scroll-back over A-15 in today's shape (a transcript walk from a
   * `FeedPageCursor`). The cut-1 switch routes A-15 `host` with its target shape, so the one scroll-back left is
   * `olderFromHost` below; `unpageable` and `beyondReach` stay in the state for `pagingNoteOf`, and the Host never sets
   * them (its log holds at most 50 rows per dwarf, PO #87).
   */

  /**
   * Ask the Host for the page before the oldest row held, with A-15 in its 14 shape (ISSUE-106; 14 §2.1 row A-15).
   *
   * The cursor is a `MessageId`: the oldest row of the last Host page, or, before the first, `tailOldest` (the
   * oldest row of the Host's chat, `useDwarfMessaging().hostOldestMessageId`). The refusals are `older`'s: a dwarf
   * not held, a read in flight, the start reached, and nothing to page before. A lost round trip, a refused call or
   * an answer that is not a `FeedPage` claims nothing about the conversation; the next scroll asks again. The rows
   * are mapped to today's `FeedMessage` here, so the panel draws a Host page as it draws today's.
   */
  async function olderFromHost(
    dwarfId: DwarfId,
    tailOldest: MessageId | null,
    read: HostFeedPageRead
  ): Promise<void> {
    if (state.dwarfId !== dwarfId) return
    if (state.loading || state.reachedStart || state.unpageable || state.beyondReach) return
    const before = hostCursor ?? tailOldest
    if (before === null) return

    const token = ++pageToken
    state.loading = true
    let answered: unknown
    try {
      answered = await read({ dwarfId, page: { before, limit: HOST_PAGE_LIMIT } })
    } catch {
      answered = undefined
    }
    if (token !== pageToken) return
    state.loading = false
    const parsed = hostPageAnswer.safeParse(answered)
    if (!parsed.success || !parsed.data.ok) return

    const page = parsed.data.value
    const oldest = page.messages[0]
    if (oldest !== undefined) {
      hostCursor = oldest.id
      state.pages = [page.messages.map(feedMessageOf), ...state.pages]
    }
    state.reachedStart = page.reachedStart
  }

  /** The one line the panel says about the reading, or nothing. */
  const note = computed(() => pagingNoteOf(state))

  /** For a test's own setup: this is a module-scope singleton. */
  function clear(): void {
    open(null)
  }

  return { state, note, hold, olderFromHost, clear }
}
