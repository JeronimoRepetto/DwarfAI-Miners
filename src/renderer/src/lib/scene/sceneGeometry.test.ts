import { describe, expect, it } from 'vitest'
import { clampToBox, coverScale, projectToBox, visibleImageRect } from './sceneGeometry'

/** The cave paintings: tall portrait art shown inside a much squarer panel. */
const ART = { width: 1289, height: 1600 }
/** The aspect ratio of the art itself, where nothing is cropped at all. */
const ART_ASPECT = ART.width / ART.height

describe('visibleImageRect', () => {
  it('shows the whole painting when the box has the aspect ratio of the art', () => {
    const rect = visibleImageRect({ width: 100 * ART_ASPECT, height: 100 }, ART)
    expect(rect.x0).toBeCloseTo(0)
    expect(rect.y0).toBeCloseTo(0)
    expect(rect.x1).toBeCloseTo(100)
    expect(rect.y1).toBeCloseTo(100)
  })

  /*
    `object-position: 50% 100%` pins the bottom of the art to the bottom of the
    box, because that is where the floor the dwarfs stand on is painted. A wide
    box therefore eats the ceiling, never the floor.
  */
  it('eats the ceiling and keeps the floor when the box is wider than the art', () => {
    const rect = visibleImageRect({ width: 200, height: 100 }, ART)
    expect(rect.y1).toBeCloseTo(100)
    expect(rect.y0).toBeCloseTo(100 - 100 * (ART_ASPECT / 2))
    expect(rect.x0).toBeCloseTo(0)
    expect(rect.x1).toBeCloseTo(100)
  })

  it('crops the side walls symmetrically when the box is narrower than the art', () => {
    const rect = visibleImageRect({ width: 40, height: 100 }, ART)
    expect(rect.y0).toBeCloseTo(0)
    expect(rect.y1).toBeCloseTo(100)
    const half = 50 * (0.4 / ART_ASPECT)
    expect(rect.x0).toBeCloseTo(50 - half)
    expect(rect.x1).toBeCloseTo(50 + half)
  })

  it('never reports a window wider or taller than the painting itself', () => {
    for (const aspect of [0.2, 0.5, 0.8, 1, 1.5, 3, 6]) {
      const rect = visibleImageRect({ width: 100 * aspect, height: 100 }, ART)
      expect(rect.x0, `${aspect}`).toBeGreaterThanOrEqual(0)
      expect(rect.y0, `${aspect}`).toBeGreaterThanOrEqual(0)
      expect(rect.x1, `${aspect}`).toBeLessThanOrEqual(100)
      expect(rect.y1, `${aspect}`).toBeLessThanOrEqual(100)
      expect(rect.x1, `${aspect}`).toBeGreaterThan(rect.x0)
      expect(rect.y1, `${aspect}`).toBeGreaterThan(rect.y0)
    }
  })

  it('falls back to the whole painting for a box it cannot measure yet', () => {
    expect(visibleImageRect({ width: 0, height: 0 }, ART)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 100
    })
  })
})

describe('projectToBox', () => {
  it('is the identity when the box matches the art and nothing is cropped', () => {
    const box = { width: 100 * ART_ASPECT, height: 100 }
    const projected = projectToBox({ x: 37, y: 71 }, box, ART)
    expect(projected.x).toBeCloseTo(37)
    expect(projected.y).toBeCloseTo(71)
  })

  it('keeps a point painted on the floor pinned to the bottom of any wide box', () => {
    for (const width of [120, 200, 400]) {
      const projected = projectToBox({ x: 50, y: 100 }, { width, height: 100 }, ART)
      expect(projected.y, `${width}`).toBeCloseTo(100)
      expect(projected.x, `${width}`).toBeCloseTo(50)
    }
  })

  it('stretches the surviving band of the painting across the whole box', () => {
    const box = { width: 200, height: 100 }
    const rect = visibleImageRect(box, ART)
    expect(projectToBox({ x: 50, y: rect.y0 }, box, ART).y).toBeCloseTo(0)
    expect(projectToBox({ x: 50, y: rect.y1 }, box, ART).y).toBeCloseTo(100)
  })

  /*
    This is the whole point of projecting instead of authoring in box percent:
    an anchor sits on the painted feature at every panel shape, so a dwarf at
    the ore shelf stays at the ore shelf when the user drags the panel wider.
  */
  it('tracks the same painted feature as the panel is resized', () => {
    const vein = { x: 37, y: 71 }
    const narrow = projectToBox(vein, { width: 90, height: 100 }, ART)
    const wide = projectToBox(vein, { width: 160, height: 100 }, ART)
    expect(narrow.y).not.toBeCloseTo(wide.y)
    /*
      The box percent has to move, and upward: the bottom is pinned, so a wider
      box keeps less of the painting and the vein's fixed distance above the
      floor becomes a larger share of a shorter window. Authoring in box percent
      instead would have held this number still and slid the dwarf off the rock.
    */
    expect(wide.y).toBeLessThan(narrow.y)
    expect(100 - wide.y).toBeGreaterThan(100 - narrow.y)
  })

  it('reports a point that the crop removed as outside the box, rather than lying', () => {
    // A very wide box keeps only the lowest sliver of the art, so the ceiling
    // projects above the top edge instead of being silently snapped inside it.
    const projected = projectToBox({ x: 50, y: 10 }, { width: 400, height: 100 }, ART)
    expect(projected.y).toBeLessThan(0)
  })

  it('hands back the authored point when the box has not been measured yet', () => {
    expect(projectToBox({ x: 37, y: 71 }, { width: 0, height: 0 }, ART)).toEqual({ x: 37, y: 71 })
  })
})

describe('clampToBox', () => {
  it('leaves a point that is already comfortably inside alone', () => {
    expect(clampToBox({ x: 50, y: 50 }, 6, 4)).toEqual({ x: 50, y: 50 })
  })

  it('holds a cropped-away point at the edge, keeping the dwarf on screen', () => {
    expect(clampToBox({ x: -20, y: -30 }, 6, 4)).toEqual({ x: 6, y: 4 })
    expect(clampToBox({ x: 140, y: 130 }, 6, 4)).toEqual({ x: 94, y: 96 })
  })
})

/*
  The other half of the same `cover` sum visibleImageRect does. That one asks
  WHICH slice of the painting survives; this one asks how much bigger everything
  in that slice is drawn — which is what a figure standing in the painting has to
  be scaled by to stay the right size next to the rock (issue #44, sceneSizing).
*/
describe('coverScale', () => {
  it('scales the art until it covers the box, so exactly one axis overflows', () => {
    // Wider than the art: the width binds and the extra height is the crop.
    expect(coverScale({ width: 200, height: 100 }, ART)).toBeCloseTo(200 / ART.width)
    // Narrower than the art: the height binds and the side walls are the crop.
    expect(coverScale({ width: 40, height: 100 }, ART)).toBeCloseTo(100 / ART.height)
  })

  it('agrees with visibleImageRect about which axis got cropped', () => {
    for (const aspect of [0.2, 0.5, 0.8, 1, 1.5, 3, 6]) {
      const box = { width: 100 * aspect, height: 100 }
      const rect = visibleImageRect(box, ART)
      const widthBound = coverScale(box, ART) === box.width / ART.width
      // A width-bound cover keeps the whole width and crops height, and vice versa.
      expect(rect.x1 - rect.x0 === 100, `${aspect}`).toBe(widthBound)
    }
  })

  it('reports no scale at all for a box it cannot measure yet', () => {
    expect(coverScale({ width: 0, height: 0 }, ART)).toBe(0)
    expect(coverScale({ width: 428, height: 512 }, { width: 0, height: 0 })).toBe(0)
  })
})
