import { describe, expect, it } from 'vitest'
import {
  STICK_TO_BOTTOM_TOLERANCE_PX,
  TOP_OF_LIST_TOLERANCE_PX,
  nextScrollTop,
  reachedTopOfList,
  rowsWerePrepended,
  scrollTopAfterPrepend,
  shouldStickToBottom
} from './listScroll'

/**
 * #195: the history list snapped to the top on every re-read (`selectedFeed`
 * was blanked before each one) and a row arriving below the fold could not
 * move a reader who was reading further up — the two symptoms the maintainer
 * named as one bug ("the panel looked frozen mid-session"). These pure
 * functions are the decision the component only applies: capture whether the
 * reader was at the bottom BEFORE new rows land, then write that verdict back
 * as the scrollTop AFTER they do.
 */
describe('shouldStickToBottom', () => {
  it('is true exactly at the bottom edge', () => {
    // 100 tall content, 20 tall viewport, scrolled all the way down: no gap.
    expect(shouldStickToBottom(80, 20, 100, STICK_TO_BOTTOM_TOLERANCE_PX)).toBe(true)
  })

  it('is true within the tolerance, so a sub-pixel rounding gap still counts as the bottom', () => {
    expect(shouldStickToBottom(78, 20, 100, STICK_TO_BOTTOM_TOLERANCE_PX)).toBe(true)
  })

  it('is false once the reader has scrolled up past the tolerance', () => {
    expect(shouldStickToBottom(50, 20, 100, STICK_TO_BOTTOM_TOLERANCE_PX)).toBe(false)
  })

  it('treats an empty or not-yet-overflowing list as at the bottom, so the first population opens there', () => {
    // scrollHeight 0, nothing to scroll: the gap is negative, never past tolerance.
    expect(shouldStickToBottom(0, 200, 0, STICK_TO_BOTTOM_TOLERANCE_PX)).toBe(true)
  })
})

describe('nextScrollTop', () => {
  it('jumps to the new bottom when the reader was sticking to it', () => {
    expect(nextScrollTop(80, 240, true)).toBe(240)
  })

  it('leaves the scroll position untouched when the reader had scrolled away from the bottom', () => {
    // A reader who scrolled up keeps their place — new rows below the fold
    // must not yank them back down (#195).
    expect(nextScrollTop(50, 240, false)).toBe(50)
  })
})

/**
 * #364: a page of older conversation lands ABOVE everything on screen, which
 * is the one growth #195's pair cannot decide. Leaving scrollTop alone there is
 * not "staying put" at all — the rows the reader was looking at slide down by
 * the height of the page, and the panel has just moved the sentence they were
 * half-way through. So the third decision: how far new rows above the fold push
 * the viewport, and when a list has grown that way rather than at its foot.
 */
describe('reachedTopOfList', () => {
  it('is true at the very top', () => {
    expect(reachedTopOfList(0, TOP_OF_LIST_TOLERANCE_PX)).toBe(true)
  })

  it('is true within the tolerance, so a flick that stops just short still asks', () => {
    expect(reachedTopOfList(TOP_OF_LIST_TOLERANCE_PX, TOP_OF_LIST_TOLERANCE_PX)).toBe(true)
  })

  it('is false anywhere else, so an ordinary scroll asks for nothing', () => {
    expect(reachedTopOfList(TOP_OF_LIST_TOLERANCE_PX + 1, TOP_OF_LIST_TOLERANCE_PX)).toBe(false)
    expect(reachedTopOfList(400, TOP_OF_LIST_TOLERANCE_PX)).toBe(false)
  })
})

describe('rowsWerePrepended', () => {
  const A = { key: 'agent-0-t1' }
  const B = { key: 'agent-1-t2' }

  it('is true when the list grew and no longer starts with the row it started with', () => {
    expect(rowsWerePrepended([A, B], [{ key: 'agent-0-t0' }, { key: 'agent-1-t1' }, B])).toBe(true)
  })

  it('is false when a row landed at the foot, which is where #195 already decides', () => {
    // The keys carry their own index, so appending leaves every earlier one
    // exactly as it was — and that is what tells the two growths apart.
    expect(rowsWerePrepended([A, B], [A, B, { key: 'agent-2-t3' }])).toBe(false)
  })

  it('is false when the list did not grow, however much its rows moved', () => {
    // A re-read whose newest page slid one row forward: the head changed and
    // nothing was added, so nothing was pushed down either.
    expect(rowsWerePrepended([A, B], [B, { key: 'agent-1-t3' }])).toBe(false)
  })

  it('is false for a list that had nothing in it, which is a first population', () => {
    expect(rowsWerePrepended([], [A, B])).toBe(false)
  })
})

describe('scrollTopAfterPrepend', () => {
  it('pushes the viewport down by exactly the height that landed above it', () => {
    // 120 of new rows above the fold: the row the reader was on is 120 lower
    // than it was, and this is what keeps it under their eye.
    expect(scrollTopAfterPrepend(30, 240, 360)).toBe(150)
  })

  it('keeps a reader at the very top looking at the first NEW row, not at the old one', () => {
    expect(scrollTopAfterPrepend(0, 240, 360)).toBe(120)
  })

  it('leaves the scroll alone when nothing above it actually grew', () => {
    expect(scrollTopAfterPrepend(30, 240, 240)).toBe(30)
  })

  it('never scrolls backwards on a list that somehow shrank', () => {
    expect(scrollTopAfterPrepend(30, 360, 240)).toBe(30)
  })
})
