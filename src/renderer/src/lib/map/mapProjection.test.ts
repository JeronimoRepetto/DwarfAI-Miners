import { describe, expect, it } from 'vitest'
import { MAP_ART_SIZE } from '../art'
import { clampToMapBox, coverScaleOf, projectToMapBox, visibleMapRect } from './mapProjection'

/** The delivered map art. Every case below is projected against this. */
const ART = MAP_ART_SIZE

/**
 * Where the browser actually draws one image pixel, derived from the CSS rules
 * rather than from the module under test.
 *
 * `object-fit: cover` scales the painting by whichever axis needs more to cover
 * the box, and `object-position: 50% 50%` centres the overflow. So a painting
 * pixel lands at `offset + pixel * scale`, and this is the whole of it — twelve
 * lines of first principles, so the projection is checked against the CSS and
 * not against a second copy of itself.
 */
function drawnAt(
  pixelX: number,
  pixelY: number,
  box: { width: number; height: number },
  image: { width: number; height: number }
): { x: number; y: number } {
  const scale = Math.max(box.width / image.width, box.height / image.height)
  const offsetX = (box.width - image.width * scale) / 2
  const offsetY = (box.height - image.height * scale) / 2
  return { x: offsetX + pixelX * scale, y: offsetY + pixelY * scale }
}

/** Box shapes a resizable panel really reaches, plus two absurd ones. */
const BOXES = [
  { name: 'the art’s own ratio', width: 464, height: 576 },
  { name: 'the default panel', width: 460, height: 545 },
  { name: 'a tall sliver', width: 300, height: 1200 },
  { name: 'a wide letterbox', width: 1200, height: 400 },
  { name: 'a square', width: 600, height: 600 },
  { name: 'one pixel wide', width: 1, height: 900 }
]

describe('projectToMapBox', () => {
  /*
    The property the whole slice rests on: a point authored ON the painting must
    come out where that painting pixel is actually drawn, at every panel shape.
    Authoring in box percent (which is what the old 13-site map did) fails this
    the moment the panel stops being the shape it was authored at.
  */
  it.each(BOXES)('puts an authored point on its own pixel in $name', (box) => {
    const authored: readonly (readonly [number, number])[] = [
      [0, 0],
      [50, 50],
      [100, 100],
      [17.56, 34.78],
      [80.82, 92.9],
      [31.92, 28.89]
    ]
    for (const [imageX, imageY] of authored) {
      const projected = projectToMapBox({ x: imageX, y: imageY }, box, ART)
      const expected = drawnAt((imageX / 100) * ART.width, (imageY / 100) * ART.height, box, ART)
      expect(projected.x * (box.width / 100)).toBeCloseTo(expected.x, 6)
      expect(projected.y * (box.height / 100)).toBeCloseTo(expected.y, 6)
    }
  })

  it('leaves the centre of the painting at the centre of the box, whatever the crop', () => {
    for (const box of BOXES) {
      const centre = projectToMapBox({ x: 50, y: 50 }, box, ART)
      expect(centre.x).toBeCloseTo(50, 9)
      expect(centre.y).toBeCloseTo(50, 9)
    }
  })

  /*
    Deliberately un-clamped, exactly as sceneGeometry.projectToBox is: a caller
    has to be able to tell "the crop ate this point" from "this point is at the
    edge". Clamping is a separate decision, taken by clampToMapBox below.
  */
  it('reports a cropped point outside 0-100 rather than pretending it is at the edge', () => {
    const letterbox = { width: 1200, height: 400 }
    const top = projectToMapBox({ x: 50, y: 0 }, letterbox, ART)
    expect(top.y).toBeLessThan(0)
    const bottom = projectToMapBox({ x: 50, y: 100 }, letterbox, ART)
    expect(bottom.y).toBeGreaterThan(100)
  })

  it('is the identity when the box has the painting’s own ratio', () => {
    const exact = { width: ART.width / 4, height: ART.height / 4 }
    for (const point of [
      { x: 0, y: 0 },
      { x: 24.16, y: 88.84 },
      { x: 100, y: 100 }
    ]) {
      const projected = projectToMapBox(point, exact, ART)
      expect(projected.x).toBeCloseTo(point.x, 9)
      expect(projected.y).toBeCloseTo(point.y, 9)
    }
  })

  it('leaves an unmeasured box alone rather than dividing by zero', () => {
    const point = { x: 31.92, y: 28.89 }
    expect(projectToMapBox(point, { width: 0, height: 0 }, ART)).toEqual(point)
  })
})

describe('visibleMapRect', () => {
  it('shows the whole painting when the box shares its ratio', () => {
    const rect = visibleMapRect({ width: 928, height: 1152 }, ART)
    expect(rect.x0).toBeCloseTo(0, 6)
    expect(rect.y0).toBeCloseTo(0, 6)
    expect(rect.x1).toBeCloseTo(100, 6)
    expect(rect.y1).toBeCloseTo(100, 6)
  })

  /*
    Centred, not bottom-pinned. This is the one thing that differs from the
    cave's sceneGeometry.visibleImageRect, and getting it wrong slides every
    marker up or down its own hillside as the panel is resized.
  */
  it('crops a wide box’s sky and floor by the same amount', () => {
    const rect = visibleMapRect({ width: 1200, height: 400 }, ART)
    expect(rect.x0).toBe(0)
    expect(rect.x1).toBe(100)
    expect(rect.y0).toBeCloseTo(100 - rect.y1, 9)
    expect(rect.y0).toBeGreaterThan(0)
  })

  it('crops a narrow box’s two side margins by the same amount', () => {
    const rect = visibleMapRect({ width: 300, height: 1200 }, ART)
    expect(rect.y0).toBe(0)
    expect(rect.y1).toBe(100)
    expect(rect.x0).toBeCloseTo(100 - rect.x1, 9)
    expect(rect.x0).toBeGreaterThan(0)
  })

  it('reports the whole painting for a box nothing has measured yet', () => {
    expect(visibleMapRect({ width: 0, height: 500 }, ART)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 100
    })
  })
})

describe('coverScaleOf', () => {
  it('is whichever axis needs the most magnification', () => {
    expect(coverScaleOf({ width: 928, height: 1152 }, ART)).toBeCloseTo(0.5, 9)
    expect(coverScaleOf({ width: 1856, height: 100 }, ART)).toBeCloseTo(1, 9)
    expect(coverScaleOf({ width: 100, height: 2304 }, ART)).toBeCloseTo(1, 9)
  })

  it('reports zero for an unmeasured box rather than Infinity', () => {
    expect(coverScaleOf({ width: 0, height: 0 }, ART)).toBe(0)
  })
})

describe('clampToMapBox', () => {
  /*
    The design does not say what happens to a marker whose spawn point the crop
    removed — the panel it was drawn for is exactly the painting's ratio, so
    nothing is ever cropped there. Ours is resizable, so this is a decision:
    hold the marker at the edge, the way the cave already holds a dwarf whose
    rock got cropped away, rather than let a live mine vanish off the panel.
  */
  it('holds a cropped point at the edge, a margin in', () => {
    expect(clampToMapBox({ x: -40, y: 130 }, 2, 3)).toEqual({ x: 2, y: 97 })
  })

  it('leaves a point that is already inside exactly where it is', () => {
    expect(clampToMapBox({ x: 45.5, y: 61.25 }, 2, 3)).toEqual({ x: 45.5, y: 61.25 })
  })
})
