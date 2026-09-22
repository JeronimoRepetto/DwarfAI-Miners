/**
 * Which list entries #566 T4b's shared entrance (`fadeVariants`, in
 * `lib/shell/presence.ts`) may animate: a genuine arrival at the tail of a
 * list the reader was already looking at, and nothing else.
 *
 * Framework-agnostic on purpose, the same split every other `lib/message`
 * file keeps: `DwarfMessagePanel.vue` and `MineHistoryPanel.vue` both draw a
 * list of `PanelEntry`-shaped rows keyed by `entry.key`, and both need the
 * same answer to "did this render actually bring something new, or did it
 * only rearrange what was already on screen" — a page paging in ahead of the
 * reader (#430), a run of tool calls folding or unfolding, an echo
 * reconciling into its transcript row (#309), a history tab switching to a
 * different speaker's messages. None of those is news; only a message
 * landing after everything the reader had already seen is.
 */

/**
 * The keys in `next` that are a genuine arrival after everything in
 * `previous` — an ordinary append, or the shape `speakerRows`' own
 * MINE_HISTORY_MESSAGE_LIMIT window slides in (the array stays the same
 * length, its own oldest entry falls off the FRONT, and one new entry lands
 * at the tail; #566 T4b design point 4).
 *
 * The rule: walk in from the end of `next` for keys `previous` does not
 * carry at all, stopping at the first key `previous` DOES carry. That run is
 * the candidate arrival. It only counts if what is left of `next` once that
 * run is removed is EXACTLY a suffix of `previous`, in the same order —
 * proof that nothing survived out of place, only (at most) fell off the
 * front. Anything else — a row replaced in the middle rather than merely
 * appended after (an echo reconciling into its transcript row, #309), a
 * reorder, a list that only shrank — answers empty, which is the direction
 * this is meant to be wrong in: it costs an entrance a reader might have
 * liked seeing, never a stagger over rows they were already looking at.
 *
 * Deliberately blind to one shape: two lists sharing no keys at all reads as
 * "every key in `next` arrived", because nothing here says otherwise — a
 * wholesale swap (a history tab choosing a different speaker) looks
 * identical to a very large arrival from key comparison alone. A caller with
 * a selection of its own (`MineHistoryPanel`'s chosen tab) must notice that
 * swap itself and skip calling this function rather than rely on it here;
 * `DwarfMessagePanel` never swaps like this within one mounted instance — a
 * different dwarf is a different component instance (`:key`), a cut Vue
 * gives it for free.
 */
export function tailArrivals(
  previous: readonly string[],
  next: readonly string[]
): ReadonlySet<string> {
  const previousKeys = new Set(previous)
  let arrivalCount = 0
  while (arrivalCount < next.length && !previousKeys.has(next[next.length - 1 - arrivalCount]!)) {
    arrivalCount++
  }
  if (arrivalCount === 0) return new Set()

  const survivors = next.slice(0, next.length - arrivalCount)
  const expected = previous.slice(previous.length - survivors.length)
  if (survivors.length !== expected.length) return new Set()
  for (let index = 0; index < survivors.length; index++) {
    if (survivors[index] !== expected[index]) return new Set()
  }
  return new Set(next.slice(next.length - arrivalCount))
}
