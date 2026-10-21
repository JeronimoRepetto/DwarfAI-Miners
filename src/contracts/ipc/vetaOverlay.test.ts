import { describe, expect, it } from 'vitest'
import { vetaOverlayFrame } from './vetaOverlay'

/*
 * ISSUE-288 (TC-288-04; ADR-025 item 2; 07 N-25; 14 §3.9 `VetaLayoutRequest {kind:'overlay'}`): the window an open
 * overlay grows Veta to, which UI main places the window by; the Veta renderer pins the island and the overlay inside
 * it by the same rule, so the island never moves on the screen.
 */

const ISLAND = { length: 120, thickness: 52 }
const MENU = { width: 200, height: 160 }

describe('the Veta overlay frame', () => {
  it('[ADR-025, S22.01] an overlay sits beside the island on the screen side, aligned to its anchored end, on every edge', () => {
    // Bottom edge, anchored at the end (right): the overlay above, both flush right.
    expect(vetaOverlayFrame({ edge: 'bottom', end: 'end' }, ISLAND, MENU)).toEqual({
      width: 200,
      height: 212,
      island: { x: 80, y: 160 },
      overlay: { x: 0, y: 0 }
    })
    // Top edge, anchored at the start (left): the overlay below, both flush left.
    expect(vetaOverlayFrame({ edge: 'top', end: 'start' }, ISLAND, MENU)).toEqual({
      width: 200,
      height: 212,
      island: { x: 0, y: 0 },
      overlay: { x: 0, y: 52 }
    })
    // Left edge, anchored at the end (bottom): the island is a column, the overlay to its right, both flush bottom.
    expect(vetaOverlayFrame({ edge: 'left', end: 'end' }, ISLAND, MENU)).toEqual({
      width: 252,
      height: 160,
      island: { x: 0, y: 40 },
      overlay: { x: 52, y: 0 }
    })
    // Right edge, anchored at the start (top): the overlay to the island's left, both flush top.
    expect(vetaOverlayFrame({ edge: 'right', end: 'start' }, ISLAND, MENU)).toEqual({
      width: 252,
      height: 160,
      island: { x: 200, y: 0 },
      overlay: { x: 0, y: 0 }
    })
    // An island longer than the overlay: the window is as long as the island, the overlay at its anchored end.
    expect(
      vetaOverlayFrame({ edge: 'bottom', end: 'end' }, { length: 300, thickness: 52 }, MENU)
    ).toEqual({ width: 300, height: 212, island: { x: 0, y: 160 }, overlay: { x: 100, y: 0 } })
  })
})
