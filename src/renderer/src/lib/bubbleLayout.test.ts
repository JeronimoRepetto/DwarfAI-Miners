import { describe, expect, it } from 'vitest'
import { BUBBLE_ROW_HEIGHT_PX, bubbleRowOffsetPx } from './bubbleLayout'

describe('bubbleRowOffsetPx', () => {
  it('leaves the sole occupant of an anchor exactly where the bubble sits today', () => {
    expect(bubbleRowOffsetPx(0)).toBe(0)
  })

  it('lifts each further sharer by one row so it clears the ones below it', () => {
    expect(bubbleRowOffsetPx(1)).toBe(BUBBLE_ROW_HEIGHT_PX)
    expect(bubbleRowOffsetPx(2)).toBe(BUBBLE_ROW_HEIGHT_PX * 2)
    expect(bubbleRowOffsetPx(3)).toBe(BUBBLE_ROW_HEIGHT_PX * 3)
  })

  it('never drops a bubble below its default spot for a malformed negative index', () => {
    expect(bubbleRowOffsetPx(-2)).toBe(0)
  })
})
