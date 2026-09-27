import { describe, expect, it } from 'vitest'
import { TIP_DELAY_MS, TIP_GAP, placeTip } from './tipCard'

// A 20x20 target in the middle of a 400x300 window, and a 100x40 card.
const target = { left: 190, top: 140, width: 20, height: 20 }
const card = { width: 100, height: 40 }
const view = { width: 400, height: 300 }

describe('the tooltip card timing', () => {
  it('waits the design’s 300ms for a pointer, and places the card 8px from its target', () => {
    expect(TIP_DELAY_MS).toBe(300)
    expect(TIP_GAP).toBe(8)
  })
})

describe('placeTip', () => {
  it('sits above its target, centred on it, by default', () => {
    expect(placeTip(target, card, view)).toEqual({ left: 150, top: 92, side: 'top' })
  })

  it('aligns to the target’s start edge when asked', () => {
    expect(placeTip(target, card, view, { align: 'start' })).toEqual({
      left: 190,
      top: 92,
      side: 'top'
    })
  })

  it('goes beside the target on the right or the left, centred on it', () => {
    expect(placeTip(target, card, view, { side: 'right' })).toEqual({
      left: 218,
      top: 130,
      side: 'right'
    })
    expect(placeTip(target, card, view, { side: 'left' })).toEqual({
      left: 82,
      top: 130,
      side: 'left'
    })
  })

  it('flips below a target too near the top to stay on screen', () => {
    const high = { ...target, top: 10 }
    expect(placeTip(high, card, view)).toEqual({ left: 150, top: 38, side: 'bottom' })
  })

  it('flips to the other side when the right has no room', () => {
    const edge = { ...target, left: 350 }
    expect(placeTip(edge, card, view, { side: 'right' }).side).toBe('left')
  })

  it('holds the card inside the window along the side it sits on', () => {
    const corner = { ...target, left: 2 }
    expect(placeTip(corner, card, view).left).toBe(0)
    const far = { ...target, left: 395 }
    expect(placeTip(far, card, view).left).toBe(view.width - card.width)
  })

  it('pins a card bigger than the window to its near edge, so its first line survives', () => {
    const tiny = { width: 60, height: 30 }
    const placed = placeTip(target, card, tiny)
    expect(placed.left).toBe(0)
    expect(placed.top).toBe(0)
  })
})
