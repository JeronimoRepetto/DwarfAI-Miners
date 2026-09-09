/**
 * The music order (#174): every track once, in a random order, then a fresh
 * order, forever.
 *
 * Pure and injected with its own randomness, which is what makes "no repeats"
 * something a test can hold rather than something a listener has to notice
 * over twenty minutes.
 */

/**
 * Fisher-Yates, over a copy.
 *
 * Over a COPY because the caller's list is the asset table (see
 * audioAssets.ts) — a module-scope constant that would be reordered in place
 * for the life of the process, so the second round would be shuffling a list
 * the first round had already rewritten.
 */
export function shuffleOrder<T>(items: readonly T[], random: () => number): T[] {
  const order = [...items]
  for (let index = order.length - 1; index > 0; index--) {
    const pick = Math.floor(random() * (index + 1))
    // Both indices are in range by construction — `index` walks down from the
    // last element and `pick` is floored below it — so the swap is asserted
    // rather than guarded, which would be a branch no input can reach.
    const held = order[index]!
    order[index] = order[pick]!
    order[pick] = held
  }
  return order
}

export interface Playlist<T> {
  /** The next track, or undefined when there are none at all. */
  next: () => T | undefined
}

/**
 * A cycle over `items`: a shuffled round, then another, with no track played
 * twice inside a round and none played twice ACROSS the seam either.
 *
 * That second rule is the one worth stating. A plain reshuffle satisfies "no
 * repeats within a round" and still lets the track that closed one round open
 * the next — which is the only repeat a listener could ever actually hear as
 * one, since nobody remembers position four of the previous round. So a fresh
 * order that would open on the track just played is rotated by one before it
 * is handed out.
 *
 * With a single track there is no choice to make and it repeats; with none the
 * playlist has nothing to play and says so, because #174 asks for silence
 * rather than a placeholder when nothing was provided.
 */
export function createPlaylist<T>(items: readonly T[], random: () => number): Playlist<T> {
  let queue: T[] = []
  let lastPlayed: T | undefined

  function refill(): void {
    queue = shuffleOrder(items, random)
    // Rotated rather than reshuffled: a reshuffle could draw the same opener
    // again and again, so the loop would be unbounded on a run of bad luck for
    // a guarantee a single swap already gives.
    if (queue.length > 1 && queue[0] === lastPlayed) {
      queue.push(queue.shift() as T)
    }
  }

  return {
    next(): T | undefined {
      if (queue.length === 0) refill()
      const track = queue.shift()
      if (track !== undefined) lastPlayed = track
      return track
    }
  }
}
