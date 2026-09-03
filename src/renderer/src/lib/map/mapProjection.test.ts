import { describe, expect, it } from 'vitest'
import { MAP_ART_SIZE } from '../art'
import { clampToMapBox, drawnMapRect, mapFitScale, projectToMapBox } from './mapProjection'

/** The delivered map art. Every case below is projected against this. */
const ART = MAP_ART_SIZE

/**
 * Where the browser actually draws one image pixel, derived from the CSS rules
 * rather than from the module under test.
 *
 * `object-fit: contain` scales the painting by whichever axis needs LESS, so the
 * whole painting survives at every box shape, and `object-position: 50% 50%`
 * centres the letterbox. So a painting pixel lands at `offset + pixel * scale`,
 * and this is the whole of it — twelve lines of first principles, so the
 * projection is checked against the CSS and not against a second copy of itself.
 *
 * AMENDED for #153: this helper used `Math.max` — the `cover` crop `map.md`
 * asks for. The maintainer's acceptance run overrode that ruling ("the whole
 * painting must be visible, aspect preserved, no crop"), so one `max` became a
 * `min` here and in the module, and every case below now describes a letterbox
 * where it used to describe a crop.
 */
function drawnAt(
  pixelX: number,
  pixelY: number,
  box: { width: number; height: number },
  image: { width: number; height: number }
): { x: number; y: number } {
  const scale = Math.min(box.width / image.width, box.height / image.height)
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
    AMENDED for #153. This case used to prove that a point the CROP removed came
    back outside 0-100 — the whole reason the projection was deliberately
    un-clamped. Nothing is cropped any more, so no point can leave the box, and
    what has to be proved instead is the opposite: every corner of the painting
    lands INSIDE the box at every shape, which is the maintainer's ruling stated
    as a property. `clampToMapBox` below still exists for the marker's own
    half-width, which is a different reason to hold a point in.
  */
  it('keeps every corner of the painting inside the box, at every shape', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 }
    ]
    for (const box of BOXES) {
      for (const corner of corners) {
        const projected = projectToMapBox(corner, box, ART)
        expect(projected.x).toBeGreaterThanOrEqual(-1e-9)
        expect(projected.x).toBeLessThanOrEqual(100 + 1e-9)
        expect(projected.y).toBeGreaterThanOrEqual(-1e-9)
        expect(projected.y).toBeLessThanOrEqual(100 + 1e-9)
      }
    }
  })

  it('spends the whole of whichever axis binds, and letterboxes the other', () => {
    // A box taller than the painting's ratio: the full width is used and the
    // spare height becomes equal empty bands, which is what "width follows the
    // height" costs when the column is narrower than the rule wants.
    const tall = { width: 300, height: 1200 }
    expect(projectToMapBox({ x: 0, y: 0 }, tall, ART).x).toBeCloseTo(0, 9)
    expect(projectToMapBox({ x: 100, y: 0 }, tall, ART).x).toBeCloseTo(100, 9)
    expect(projectToMapBox({ x: 0, y: 0 }, tall, ART).y).toBeGreaterThan(0)
    // A box wider than the ratio: the full height is used, exactly as the
    // acceptance ruling asks for, and the width follows.
    const wide = { width: 1200, height: 400 }
    expect(projectToMapBox({ x: 0, y: 0 }, wide, ART).y).toBeCloseTo(0, 9)
    expect(projectToMapBox({ x: 0, y: 100 }, wide, ART).y).toBeCloseTo(100, 9)
    expect(projectToMapBox({ x: 0, y: 0 }, wide, ART).x).toBeGreaterThan(0)
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

/*
 * REMOVED with the crop (#153), stated here rather than passing unseen:
 * `visibleMapRect`'s four cases — "shows the whole painting when the box shares
 * its ratio", "crops a wide box's sky and floor by the same amount", "crops a
 * narrow box's two side margins by the same amount" and "reports the whole
 * painting for a box nothing has measured yet" — and `coverScaleOf`'s two, "is
 * whichever axis needs the most magnification" and "reports zero for an
 * unmeasured box rather than Infinity".
 *
 * Both functions are gone. `visibleMapRect` answered "which SLICE of the
 * painting survives the crop", in image percent, and under the acceptance
 * ruling the answer is always "all of it". `coverScaleOf` was the crop's own
 * magnification and had no caller left once the crop went. What replaces them
 * is `drawnMapRect` — where the painting is drawn, in BOX percent — and
 * `mapFitScale`, the `contain` factor. The same four questions are asked of
 * them below, turned inside out.
 */
describe('drawnMapRect', () => {
  it('fills the box exactly when the box shares the painting’s ratio', () => {
    const rect = drawnMapRect({ width: 928, height: 1152 }, ART)
    expect(rect.x0).toBeCloseTo(0, 6)
    expect(rect.y0).toBeCloseTo(0, 6)
    expect(rect.x1).toBeCloseTo(100, 6)
    expect(rect.y1).toBeCloseTo(100, 6)
  })

  it('spends a wide box’s full height and letterboxes its two side margins equally', () => {
    const rect = drawnMapRect({ width: 1200, height: 400 }, ART)
    expect(rect.y0).toBeCloseTo(0, 9)
    expect(rect.y1).toBeCloseTo(100, 9)
    expect(rect.x0).toBeCloseTo(100 - rect.x1, 9)
    expect(rect.x0).toBeGreaterThan(0)
  })

  it('spends a narrow box’s full width and letterboxes above and below equally', () => {
    const rect = drawnMapRect({ width: 300, height: 1200 }, ART)
    expect(rect.x0).toBeCloseTo(0, 9)
    expect(rect.x1).toBeCloseTo(100, 9)
    expect(rect.y0).toBeCloseTo(100 - rect.y1, 9)
    expect(rect.y0).toBeGreaterThan(0)
  })

  it('reports the whole box for one nothing has measured yet', () => {
    expect(drawnMapRect({ width: 0, height: 500 }, ART)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 100
    })
  })
})

describe('mapFitScale', () => {
  it('is whichever axis needs the least magnification, so nothing is cropped', () => {
    expect(mapFitScale({ width: 928, height: 1152 }, ART)).toBeCloseTo(0.5, 9)
    expect(mapFitScale({ width: 1856, height: 100 }, ART)).toBeCloseTo(100 / 2304, 9)
    expect(mapFitScale({ width: 100, height: 2304 }, ART)).toBeCloseTo(100 / 1856, 9)
  })

  it('reports zero for an unmeasured box rather than Infinity', () => {
    expect(mapFitScale({ width: 0, height: 0 }, ART)).toBe(0)
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
