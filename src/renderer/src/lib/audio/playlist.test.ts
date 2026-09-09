import { describe, expect, it } from 'vitest'
import { createPlaylist, shuffleOrder } from './playlist'

/**
 * A seeded generator, so an order this suite asserts is the order the code
 * really produced rather than one that happened to come up. Mulberry32: small,
 * well-distributed, and deterministic from its seed.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SIX = ['a', 'b', 'c', 'd', 'e', 'f'] as const

describe('shuffleOrder', () => {
  it('returns every item exactly once', () => {
    const order = shuffleOrder(SIX, seededRandom(1))
    expect([...order].sort()).toEqual([...SIX].sort())
  })

  it('leaves the list it was given untouched', () => {
    const items = [...SIX]
    shuffleOrder(items, seededRandom(2))
    expect(items).toEqual([...SIX])
  })

  it('actually reorders, rather than handing the same sequence back', () => {
    expect(shuffleOrder(SIX, seededRandom(7))).not.toEqual([...SIX])
  })

  it('gives two different seeds two different orders', () => {
    expect(shuffleOrder(SIX, seededRandom(3))).not.toEqual(shuffleOrder(SIX, seededRandom(4)))
  })

  it('handles the degenerate lists without special-casing at the call site', () => {
    expect(shuffleOrder([], seededRandom(1))).toEqual([])
    expect(shuffleOrder(['only'], seededRandom(1))).toEqual(['only'])
  })
})

describe('createPlaylist', () => {
  it('plays every track once before any of them comes round again', () => {
    const playlist = createPlaylist(SIX, seededRandom(11))
    const round = Array.from({ length: 6 }, () => playlist.next())
    expect(new Set(round).size).toBe(6)
    expect([...round].sort()).toEqual([...SIX].sort())
  })

  it('reshuffles into a different order for the next round', () => {
    const playlist = createPlaylist(SIX, seededRandom(11))
    const first = Array.from({ length: 6 }, () => playlist.next())
    const second = Array.from({ length: 6 }, () => playlist.next())
    expect(second).not.toEqual(first)
    expect([...second].sort()).toEqual([...SIX].sort())
  })

  it('never opens a new round on the track that just closed the previous one', () => {
    // The one repeat a plain reshuffle can still produce, and the only one a
    // listener would ever hear as a repeat: the same track twice in a row
    // across the seam. Checked over many seeds because it is the seam that is
    // rare, not the rule.
    for (let seed = 1; seed <= 200; seed++) {
      const playlist = createPlaylist(SIX, seededRandom(seed))
      const played = Array.from({ length: 18 }, () => playlist.next())
      for (let index = 1; index < played.length; index++) {
        expect(played[index]).not.toBe(played[index - 1])
      }
    }
  })

  it('loops forever, one full round at a time', () => {
    const playlist = createPlaylist(SIX, seededRandom(12))
    for (let round = 0; round < 5; round++) {
      const played = Array.from({ length: 6 }, () => playlist.next())
      expect([...played].sort()).toEqual([...SIX].sort())
    }
  })

  it('repeats the one track it has, because there is nothing else to play', () => {
    // The no-repeat rule is about choice. With a single track there is none,
    // and going silent instead would be worse than the repeat.
    const playlist = createPlaylist(['only'], seededRandom(1))
    expect([playlist.next(), playlist.next(), playlist.next()]).toEqual(['only', 'only', 'only'])
  })

  it('has nothing to play when it was given nothing', () => {
    // The engine plays what it is given and stays silent when given nothing —
    // never a placeholder track (#174).
    const playlist = createPlaylist([], seededRandom(1))
    expect(playlist.next()).toBeUndefined()
  })
})
