import type { FeedMessage, FeedPageCursor } from '../../types'

/**
 * Older pages of one dwarf's conversation, and the seam where they meet the
 * newest one (#364).
 *
 * The panel opens on the newest `FEED_LIMIT` things said and every re-read and
 * every watched push (#196) replaces exactly that page. Pages the reader asked
 * for are held BESIDE it rather than folded into it, and joined for drawing
 * only — which is what keeps a push from erasing four pages of scrollback, and
 * what keeps the #249 shrink warning comparing one newest page against another
 * instead of against a conversation that legitimately grew upward.
 *
 * Pure, like `listScroll` and `panelHeight` beside it: the composable owns when
 * a page is asked for, and this file owns which row it is asked for and what
 * the join looks like.
 */

/** In flight, in the register of `conversation.ts`'s READING_NOTE. */
export const READING_OLDER_NOTE = 'Reading the conversation before this...'
/**
 * The last page came back. Said once and standing: the panel stops asking, and
 * the reader is told why nothing more arrives however far they scroll.
 */
export const CONVERSATION_START_NOTE = 'This is the start of the conversation.'
/**
 * `readable: false` — this conversation cannot be paged at all. Its own
 * sentence, never the start note: a session that keeps nothing this app can
 * page has not been read back to its beginning, and saying so would be a claim
 * about a transcript nobody read (the distinction `DwarfFeedPage` draws).
 */
export const NO_OLDER_PAGES_NOTE = 'The conversation before this cannot be read.'
/**
 * The page came back EMPTY and not the start — the one answer `readFeedPage`
 * gives when its widest window filled and the cursor was not inside it.
 *
 * The walk stops at `FEED_WINDOW_CEILING_BYTES`, so this is a transcript that
 * goes on past the furthest the read is willing to reach. Its own sentence, and
 * for the sharpest of the three reasons: `reachedStart` would be a plain lie —
 * there IS more conversation, and the reader is not at its beginning — while
 * NO_OLDER_PAGES_NOTE would claim the transcript cannot be read at all, when in
 * fact everything on screen came out of it. So it says what is true, and names
 * the one place that still has the rest: the session's own terminal, which
 * tails the file rather than reading a bounded tail of it.
 *
 * It stops the asking exactly as the start does. A second request would read
 * the same eight mebibytes and answer the same nothing.
 */
export const BEYOND_REACH_NOTE =
  "This is as far back as the panel can read; the rest is in the session's own terminal."

/**
 * WHICH row the next page is asked for: the oldest thing SAID in what the panel
 * currently holds, or nothing when it holds no words at all.
 *
 * Activity rows are skipped rather than compared, exactly as `cursorIndex` in
 * `main/providers/feedWindow.ts` skips them on the way back: a page is measured
 * in things said (#359), so a tool-call line whose text happened to match would
 * anchor the next page in the middle of a run.
 */
export function feedPageCursorOf(messages: readonly FeedMessage[]): FeedPageCursor | null {
  for (const message of messages) {
    if (message.activity !== undefined) continue
    return { timestamp: message.timestamp, text: message.text }
  }
  return null
}

/** The pair that identifies a row on the wire — `FeedMessage` carries no id. */
function sameRow(left: FeedMessage, right: FeedMessage): boolean {
  return left.timestamp === right.timestamp && left.text === right.text
}

/**
 * How many rows at the END of `older` are the same rows as those at the START
 * of `next` — the overlap one page's read repeated.
 *
 * The SMALLEST such run, not the largest, and that is the whole care taken
 * here. A cursor is content rather than a position, so two rows equal in text
 * and timestamp resolve to the newer of the two and the page comes back
 * carrying the reader's own oldest row again — one repeat, plus whatever tool
 * calls followed that row, since a page keeps the work after its last text.
 * Matching the smallest run drops only what is demonstrably the same rows
 * twice; a longer coincidental match would delete conversation and leave a gap,
 * and `FeedPageCursor` is explicit that a repeat is the direction to be wrong
 * in because a repeat is visible and a gap in a transcript is not.
 */
function repeatedRunLength(older: readonly FeedMessage[], next: readonly FeedMessage[]): number {
  const most = Math.min(older.length, next.length)
  for (let run = 1; run <= most; run++) {
    let matches = true
    for (let offset = 0; offset < run; offset++) {
      if (!sameRow(older[older.length - run + offset]!, next[offset]!)) {
        matches = false
        break
      }
    }
    if (matches) return run
  }
  return 0
}

/**
 * What the conversation IS: every older page the reader has fetched, oldest
 * first, then the newest page — with each seam deduped.
 *
 * Folded from the newest end so a page is always joined against the rows it was
 * actually requested before, whatever number of pages stands between it and the
 * newest one.
 */
export function joinFeedPages(
  pages: readonly (readonly FeedMessage[])[],
  newest: readonly FeedMessage[]
): FeedMessage[] {
  let joined: FeedMessage[] = [...newest]
  for (let index = pages.length - 1; index >= 0; index--) {
    const older = pages[index]!
    const repeated = repeatedRunLength(older, joined)
    joined = [...older.slice(0, older.length - repeated), ...joined]
  }
  return joined
}

/**
 * The one line the panel says about paging, or nothing while the reader has
 * asked for nothing.
 *
 * What is happening now wins over what already happened: a read in flight is
 * reported even once the start has been reached, because the answer that
 * reached it is what the reader is waiting on.
 *
 * The start comes LAST of the three standing facts, which is the ordering that
 * matters. It is the only one of them that claims the reader has seen the whole
 * conversation, and both of the others exist precisely because that claim would
 * be false — so a state that somehow held two of them cannot fall out as the
 * reassuring one.
 */
export function pagingNoteOf(state: {
  loading: boolean
  reachedStart: boolean
  unpageable: boolean
  beyondReach: boolean
}): string | null {
  if (state.loading) return READING_OLDER_NOTE
  if (state.unpageable) return NO_OLDER_PAGES_NOTE
  if (state.beyondReach) return BEYOND_REACH_NOTE
  if (state.reachedStart) return CONVERSATION_START_NOTE
  return null
}
