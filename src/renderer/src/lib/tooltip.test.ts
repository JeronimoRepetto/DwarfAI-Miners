import { describe, expect, it } from 'vitest'
import { TOOLTIP_GAP, TOOLTIP_MARGIN, computeTooltipPlacement } from './tooltip'

const CONTAINER = { width: 460, height: 600 }
const TOOLTIP = { width: 190, height: 60 }

describe('computeTooltipPlacement', () => {
  it('centers above the sprite when there is room on every side', () => {
    const anchor = { left: 200, top: 300, width: 40, height: 40 }
    const placement = computeTooltipPlacement(anchor, TOOLTIP, CONTAINER)
    expect(placement).toEqual({
      left: 220 - TOOLTIP.width / 2,
      top: 300 - TOOLTIP_GAP - TOOLTIP.height,
      side: 'above'
    })
  })

  it('clamps to the left margin instead of overflowing off the left edge', () => {
    const anchor = { left: 0, top: 300, width: 40, height: 40 }
    const placement = computeTooltipPlacement(anchor, TOOLTIP, CONTAINER)
    expect(placement.left).toBe(TOOLTIP_MARGIN)
  })

  it('clamps to the right margin instead of overflowing off the right edge', () => {
    const anchor = { left: CONTAINER.width - 40, top: 300, width: 40, height: 40 }
    const placement = computeTooltipPlacement(anchor, TOOLTIP, CONTAINER)
    expect(placement.left).toBe(CONTAINER.width - TOOLTIP.width - TOOLTIP_MARGIN)
  })

  it('flips below the sprite when placing it above would clip the top edge', () => {
    const anchor = { left: 200, top: 2, width: 40, height: 40 }
    const placement = computeTooltipPlacement(anchor, TOOLTIP, CONTAINER)
    expect(placement.side).toBe('below')
    expect(placement.top).toBe(2 + 40 + TOOLTIP_GAP)
  })

  it('keeps a custom margin and gap when provided', () => {
    const anchor = { left: 0, top: 0, width: 40, height: 40 }
    const placement = computeTooltipPlacement(anchor, TOOLTIP, CONTAINER, 20, 10)
    expect(placement.left).toBe(20)
    expect(placement.side).toBe('below')
    expect(placement.top).toBe(0 + 40 + 10)
  })

  it('never returns a negative left even when the tooltip is wider than the container', () => {
    const anchor = { left: 10, top: 300, width: 20, height: 20 }
    const wideTooltip = { width: 5000, height: 60 }
    const placement = computeTooltipPlacement(anchor, wideTooltip, CONTAINER)
    expect(placement.left).toBe(TOOLTIP_MARGIN)
  })
})
