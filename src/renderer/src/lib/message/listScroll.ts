/**
 * Whether a scrollable message list opens at the newest row and stays there
 * (#195).
 *
 * The old behaviour was two bugs a single scroll call papered over:
 * `showLatest()` only ever ran on mount and on the history tab expanding, so a
 * transcript that populated AFTER mount (the ordinary case — the feed prop
 * lands async) opened on whatever the empty list's scrollTop already was, and
 * every re-read then rebuilt the row list from nothing (see App.vue's
 * `readSelectedFeed`), which reset a real browser's scrollTop to 0 on its own.
 * Neither of those is what this file fixes — App.vue no longer blanks the
 * feed, so the row list is patched rather than rebuilt — but patching alone
 * does not decide what a GROWING list should do to the scrollbar, which is
 * this file's job: capture where the reader was before new rows land, then
 * write that verdict back after.
 *
 * Since #364 it also decides what happens when rows land ABOVE the fold — a
 * page of older conversation the reader asked for — which is the one growth the
 * pair above cannot rule on: leaving the scroll alone there slides the sentence
 * they were reading down the panel.
 *
 * Every function here is pure so the panel's own tests can pin the DOM plumbing
 * (jsdom has no layout, so `scrollHeight`/`clientHeight` are asserted values,
 * never measured ones) while this file is pinned in plain node, the same split
 * `panelHeight.ts` already uses for the same reason.
 */

/**
 * The pixel slack that still counts as "at the bottom". Real content can sit
 * a fraction of a pixel short of `scrollHeight - clientHeight` from rounding
 * alone, and a reader who is visibly at the bottom must not be read as having
 * scrolled away from it over that.
 */
export const STICK_TO_BOTTOM_TOLERANCE_PX = 4

/**
 * Read BEFORE new rows are patched into the list — this is a snapshot of
 * where the reader was a moment ago, not a live measurement of where they are
 * now that the list has grown underneath them.
 */
export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerancePx: number
): boolean {
  return scrollHeight - clientHeight - scrollTop <= tolerancePx
}

/**
 * The scrollTop to write back once the list has already grown to
 * `scrollHeight`: the new bottom for a reader who was sticking to it, and
 * whatever they had otherwise — never recomputed from the new content, so a
 * reader who scrolled up keeps the exact row they left themselves at (#195).
 */
export function nextScrollTop(
  currentScrollTop: number,
  scrollHeight: number,
  stickToBottom: boolean
): number {
  return stickToBottom ? scrollHeight : currentScrollTop
}

/**
 * The slack that still counts as "at the top of what is held" (#364) — the
 * point at which the panel asks for the page before it.
 *
 * A few pixels rather than zero for the reason the bottom tolerance is not
 * zero: a wheel or a trackpad flick lands where it lands, and a reader who has
 * visibly run out of conversation must not have to nudge the bar again to be
 * read as having reached it.
 */
export const TOP_OF_LIST_TOLERANCE_PX = 8

/** Whether the reader has scrolled back to the oldest row the panel holds. */
export function reachedTopOfList(scrollTop: number, tolerancePx: number): boolean {
  return scrollTop <= tolerancePx
}

/**
 * Whether the rows that just landed went ABOVE the ones already on screen
 * (#364), rather than below them where #195's pair already decides.
 *
 * Read off the row KEYS, which is the one thing that tells the two apart
 * without a second signal to keep in step with the render. A key carries its
 * row's own index (see `panelMessagesOf`), so a row appended at the foot leaves
 * every earlier key untouched while a page prepended above shifts all of them —
 * the head key changing is exactly "something landed in front of this row".
 *
 * Guarded on the list having GROWN, because the head key also changes when the
 * newest page slides forward on a re-read: the transcript gained a reply, the
 * twelve-message window let its oldest row go, and nothing was pushed down.
 */
export function rowsWerePrepended(
  previous: readonly { key: string }[],
  next: readonly { key: string }[]
): boolean {
  if (previous.length === 0 || next.length <= previous.length) return false
  return next[0]!.key !== previous[0]!.key
}

/**
 * The scrollTop to write back once a page has landed above the fold: the
 * reader's own position plus the height that arrived in front of it, measured
 * as the difference between the two `scrollHeight` readings.
 *
 * Both readings are taken from the same element in the same tick — before Vue
 * patches the new rows in, and after it has — for the reason the pair above
 * gives: jsdom lays nothing out, so the panel's own tests assert these numbers
 * rather than measuring them, and the rule itself stays pure.
 *
 * Clamped at zero so a list that shrank between the two readings cannot pull a
 * reader backwards; there is no growth above the fold to correct for then.
 */
export function scrollTopAfterPrepend(
  currentScrollTop: number,
  previousScrollHeight: number,
  scrollHeight: number
): number {
  return currentScrollTop + Math.max(0, scrollHeight - previousScrollHeight)
}
