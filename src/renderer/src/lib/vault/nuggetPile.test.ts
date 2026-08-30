import { describe, expect, it } from 'vitest'
import {
  MAX_PILE_NUGGETS,
  MAX_PILE_SCALE,
  PILE_BASE_ROW,
  PILE_ROWS,
  pileNuggetCount,
  pileLayout,
  pileScale
} from './nuggetPile'

describe('pileNuggetCount', () => {
  it('draws one nugget per whole unit while the mound has room', () => {
    expect(pileNuggetCount(0)).toBe(0)
    expect(pileNuggetCount(1)).toBe(1)
    expect(pileNuggetCount(7)).toBe(7)
    expect(pileNuggetCount(MAX_PILE_NUGGETS)).toBe(MAX_PILE_NUGGETS)
  })

  /*
   * The cap is the whole point: a mine with millions of tokens must never emit
   * thousands of DOM nodes into a 460px panel that repaints every poll.
   */
  it('never draws more than MAX_PILE_NUGGETS however rich the mine gets', () => {
    expect(pileNuggetCount(MAX_PILE_NUGGETS + 1)).toBe(MAX_PILE_NUGGETS)
    expect(pileNuggetCount(10_000)).toBe(MAX_PILE_NUGGETS)
    expect(pileNuggetCount(50_000_000)).toBe(MAX_PILE_NUGGETS)
  })

  it('refuses negative and non-finite unit counts rather than drawing rubbish', () => {
    expect(pileNuggetCount(-4)).toBe(0)
    expect(pileNuggetCount(Number.NaN)).toBe(0)
    expect(pileNuggetCount(Number.POSITIVE_INFINITY)).toBe(MAX_PILE_NUGGETS)
  })

  it('ignores a fractional unit count, matching the whole-unit floor elsewhere', () => {
    expect(pileNuggetCount(3.9)).toBe(3)
  })
})

describe('pileLayout', () => {
  it('places nothing for an empty pile', () => {
    expect(pileLayout('mine:coal', 0)).toEqual([])
  })

  it('caps what it places at MAX_PILE_NUGGETS', () => {
    expect(pileLayout('mine:coal', 5_000)).toHaveLength(MAX_PILE_NUGGETS)
  })

  /*
   * The reason the offsets come from a hash at all: the panel re-renders on
   * every 2-second poll, and a pile that re-rolled its own jitter each time
   * would twitch continuously in the corner of the user's eye.
   */
  it('lays the same pile out identically every time it is asked', () => {
    expect(pileLayout('mine:gold', 9)).toEqual(pileLayout('mine:gold', 9))
  })

  it('gives two different piles different jitter, so they do not look cloned', () => {
    const coal = pileLayout('mine:coal', 12)
    const gold = pileLayout('mine:gold', 12)
    expect(coal.map((nugget) => nugget.rotation)).not.toEqual(gold.map((nugget) => nugget.rotation))
  })

  /*
   * Slots are addressed by row and column rather than by running index, so a
   * pile that gains a nugget grows instead of rearranging itself: every nugget
   * already on screen keeps the exact spot it had.
   */
  it('keeps every nugget already placed exactly where it was as the pile grows', () => {
    const small = pileLayout('mine:silver', 4)
    const grown = pileLayout('mine:silver', 15)
    expect(grown.slice(0, small.length)).toEqual(small)
  })

  it('fills the widest row first and stacks upward into a mound', () => {
    const full = pileLayout('mine:bronze', MAX_PILE_NUGGETS)
    const perRow = new Map<number, number>()
    for (const nugget of full) perRow.set(nugget.row, (perRow.get(nugget.row) ?? 0) + 1)
    // 6 + 5 + 4 + 3 + 2 + 1: each row above holds one fewer than the one below.
    expect([...perRow.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 6],
      [1, 5],
      [2, 4],
      [3, 3],
      [4, 2],
      [5, 1]
    ])
    expect(PILE_BASE_ROW).toBe(6)
    expect(PILE_ROWS).toBe(6)
  })

  it('starts a new row only once the row below it is full', () => {
    expect(pileLayout('mine:bronze', PILE_BASE_ROW).every((nugget) => nugget.row === 0)).toBe(true)
    const oneMore = pileLayout('mine:bronze', PILE_BASE_ROW + 1)
    expect(oneMore[oneMore.length - 1]?.row).toBe(1)
  })

  it('rises row by row and keeps the bottom row nearest the viewer', () => {
    const full = pileLayout('mine:bronze', MAX_PILE_NUGGETS)
    const bottom = full.find((nugget) => nugget.row === 0)!
    const peak = full.find((nugget) => nugget.row === 5)!
    expect(peak.y).toBeGreaterThan(bottom.y)
    expect(peak.zIndex).toBeLessThan(bottom.zIndex)
  })

  it('keeps every nugget inside its own box, jitter included', () => {
    for (const nugget of pileLayout('mine:uranium', MAX_PILE_NUGGETS)) {
      expect(nugget.x).toBeGreaterThanOrEqual(0)
      expect(nugget.x).toBeLessThanOrEqual(100)
      expect(nugget.y).toBeGreaterThanOrEqual(0)
      expect(nugget.y).toBeLessThanOrEqual(100)
    }
  })

  it('tilts and resizes each nugget a little so the mound is not a grid', () => {
    const nuggets = pileLayout('mine:copper', MAX_PILE_NUGGETS)
    expect(new Set(nuggets.map((nugget) => nugget.rotation)).size).toBeGreaterThan(1)
    expect(new Set(nuggets.map((nugget) => nugget.scale)).size).toBeGreaterThan(1)
    for (const nugget of nuggets) {
      expect(Math.abs(nugget.rotation)).toBeLessThanOrEqual(16)
      expect(nugget.scale).toBeGreaterThan(0.8)
      expect(nugget.scale).toBeLessThan(1.2)
    }
  })

  it('gives every nugget a key that is unique and stable', () => {
    const nuggets = pileLayout('mine:coal', MAX_PILE_NUGGETS)
    expect(new Set(nuggets.map((nugget) => nugget.key)).size).toBe(MAX_PILE_NUGGETS)
    expect(pileLayout('mine:coal', 3).map((nugget) => nugget.key)).toEqual(['0-0', '0-1', '0-2'])
  })
})

/*
 * Past the cap the mound stops counting and starts swelling: growth still has
 * to be visible for a mine that mines a thousand nuggets, and scale is the one
 * channel that costs no extra DOM.
 */
describe('pileScale', () => {
  it('leaves a pile that still fits at its natural size', () => {
    expect(pileScale(0)).toBe(1)
    expect(pileScale(MAX_PILE_NUGGETS)).toBe(1)
  })

  it('swells past the cap', () => {
    expect(pileScale(MAX_PILE_NUGGETS * 2)).toBeGreaterThan(1)
    expect(pileScale(MAX_PILE_NUGGETS * 8)).toBeGreaterThan(pileScale(MAX_PILE_NUGGETS * 2))
  })

  it('stops swelling at MAX_PILE_SCALE, so a huge mine cannot fill the cave', () => {
    expect(pileScale(50_000_000)).toBe(MAX_PILE_SCALE)
    expect(pileScale(Number.POSITIVE_INFINITY)).toBe(MAX_PILE_SCALE)
  })

  it('never shrinks a pile, whatever nonsense it is handed', () => {
    expect(pileScale(-10)).toBe(1)
    expect(pileScale(Number.NaN)).toBe(1)
  })
})
