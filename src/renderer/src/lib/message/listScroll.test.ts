import { describe, expect, it } from 'vitest'
import { STICK_TO_BOTTOM_TOLERANCE_PX, nextScrollTop, shouldStickToBottom } from './listScroll'

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
