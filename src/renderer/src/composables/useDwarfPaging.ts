import { computed, reactive } from 'vue'
import { feedPageCursorOf, pagingNoteOf } from '../lib/message/feedPages'
import type { DwarfFeedPage, FeedMessage } from '../types'

/**
 * The pages of conversation OLDER than the newest feed, for the dwarf the
 * message panel has open (#364).
 *
 * ## Why they are not in the feed
 *
 * `selectedFeed` in MessagePanelWindow is the newest page and nothing else: it
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
}

function emptyState(): DwarfPagingState {
  return { dwarfId: null, pages: [], loading: false, reachedStart: false, unpageable: false }
}

const state = reactive<DwarfPagingState>(emptyState())
/** Which read is the current one, so a slow answer cannot land on a later dwarf. */
let pageToken = 0

/** Whose pages these are now, throwing away whatever was held for anybody else. */
function open(dwarfId: string | null): void {
  // Bumped first: a page already in flight belongs to the conversation being
  // left, and its answer has to be refused rather than prepended here.
  pageToken++
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

  /**
   * Ask for the page before the oldest thing said in `shown` — whatever the
   * panel is currently drawing for `dwarfId`, older pages included, so the
   * cursor walks back one page per request.
   *
   * Refused without a word in four cases, none of them an error: nothing said
   * to page before, a read already in flight, the start already reached, and a
   * conversation that cannot be paged. Refused too for a dwarf whose pages this
   * store is not holding, because the answer would have nowhere to go.
   */
  async function older(dwarfId: string, shown: readonly FeedMessage[]): Promise<void> {
    if (state.dwarfId !== dwarfId) return
    if (state.loading || state.reachedStart || state.unpageable) return
    const before = feedPageCursorOf(shown)
    if (before === null) return

    const token = ++pageToken
    state.loading = true
    let page: DwarfFeedPage
    try {
      page = await window.api.getDwarfFeedPage({ dwarfId, before })
    } catch {
      // A lost round trip says nothing about the transcript, so it claims
      // nothing about it: not unpageable, not the start. The reader's next
      // scroll asks again, which is the one recovery available from here.
      if (token === pageToken) state.loading = false
      return
    }
    if (token !== pageToken) return

    state.loading = false
    if (!page.readable) {
      state.unpageable = true
      return
    }
    // An empty last page is a real answer: the cursor was the transcript's own
    // oldest row. What it carries is the flag, not the rows.
    if (page.messages.length > 0) state.pages = [[...page.messages], ...state.pages]
    state.reachedStart = page.reachedStart
  }

  /** The one line the panel says about the reading, or nothing. */
  const note = computed(() => pagingNoteOf(state))

  /** For a test's own setup: this is a module-scope singleton. */
  function clear(): void {
    open(null)
  }

  return { state, note, hold, older, clear }
}
