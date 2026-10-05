// The feed window (today's `providers/feedWindow.ts`, #215, #188, reimplemented: R16): an on-demand
// read of a transcript's newest part that widens only when it came up short. A count of messages
// is asked for, and a transcript's bytes are mostly tool output, so a fixed byte tail is either too
// narrow or too costly; the window walks outwards through these steps instead, the last one being
// the bound a very long transcript truncates at (FM-088). Pure.

/** The windows one read walks through, narrowest first (256 KiB, 2 MiB, 8 MiB). */
export const FEED_WINDOW_STEPS: readonly number[] = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]

/**
 * Up to `limit` of `rows` older than the row keyed `before` (the newest when absent), oldest first.
 * A `before` not found in `rows` answers [] (that row is outside the window or unknown).
 */
export function pageBefore<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  window: { before?: string; limit: number }
): T[] {
  const end =
    window.before === undefined ? rows.length : rows.findIndex((r) => keyOf(r) === window.before)
  if (end < 0 || window.limit <= 0) return []
  return rows.slice(Math.max(0, end - window.limit), end)
}

/** Whether a window read of `rows` must widen to answer `window` (the page reaches its start). */
export function needsWiderWindow<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  window: { before?: string; limit: number }
): boolean {
  const end =
    window.before === undefined ? rows.length : rows.findIndex((r) => keyOf(r) === window.before)
  return end < 0 || end - window.limit < 0
}
