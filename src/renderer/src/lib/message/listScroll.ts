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
 * Both functions are pure so the panel's own tests can pin the DOM plumbing
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
