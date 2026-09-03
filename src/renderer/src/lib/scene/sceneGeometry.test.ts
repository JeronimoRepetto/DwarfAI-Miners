import { describe, expect, it } from 'vitest'
import { clampToBox, drawnImageRect, fitScale, projectToBox } from './sceneGeometry'

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen: the
 * five `visibleImageRect` cases and the two `projectToBox` cases that asserted
 * the BOTTOM PIN — "eats the ceiling and keeps the floor", "crops the side
 * walls symmetrically", "keeps a point painted on the floor pinned to the
 * bottom of any wide box", "stretches the surviving band of the painting across
 * the whole box", "reports a point that the crop removed as outside the box",
 * plus `coverScale`'s "agrees with visibleImageRect about which axis got
 * cropped". They pinned `object-fit: cover; object-position: 50% 100%` on a
 * squarish concept painting whose floor had to survive the crop. The production
 * interior is a 1184x3622 tower drawn with `contain` and centred, because every
 * work point in it — from the ceiling gallery to the entrance pool — has to
 * stay on screen, so there is no floor to pin and nothing to crop away. The
 * guarantee they enforced (an authored point lands on its pixel at every panel
 * shape) did not go with them: it is `projectToBox`'s round trip below, which
 * checks it at seven box shapes and in both fits rather than at one.
 */

/** The production interior paintings: a tower, three times taller than wide. */
const ART = { width: 1184, height: 3622 }
/** The aspect ratio of the art itself, where neither fit has anything to do. */
const ART_ASPECT = ART.width / ART.height
/** Boxes across the whole range a docked column can take, and then some. */
const SHAPES = [0.05, 0.2, ART_ASPECT, 0.5, 1, 2.5, 6]

describe('drawnImageRect', () => {
  it('fills the box exactly when the box already has the aspect ratio of the art', () => {
    for (const fit of ['cover', 'contain'] as const) {
      const rect = drawnImageRect({ width: 100 * ART_ASPECT, height: 100 }, ART, fit)
      expect(rect.x0, fit).toBeCloseTo(0)
      expect(rect.y0, fit).toBeCloseTo(0)
      expect(rect.x1, fit).toBeCloseTo(100)
      expect(rect.y1, fit).toBeCloseTo(100)
    }
  })

  /*
    `contain` is what the interior actually uses. A column taller than the
    painting letterboxes it top and bottom rather than cropping the width away —
    losing 28% of the map's width at a full-screen panel height is what `cover`
    would do here, and it would strand the outermost work points.
  */
  it('letterboxes the painting inside a box it cannot fill, never cropping it', () => {
    const rect = drawnImageRect({ width: 245, height: 1040 }, ART, 'contain')
    expect(rect.x0).toBeCloseTo(0)
    expect(rect.x1).toBeCloseTo(100)
    expect(rect.y0).toBeGreaterThan(0)
    expect(rect.y1).toBeLessThan(100)
    // Centred: the bands above and below are equal.
    expect(rect.y0).toBeCloseTo(100 - rect.y1)
  })

  it('overflows the box symmetrically under cover, which is the other half of the same sum', () => {
    const rect = drawnImageRect({ width: 245, height: 1040 }, ART, 'cover')
    expect(rect.y0).toBeCloseTo(0)
    expect(rect.y1).toBeCloseTo(100)
    expect(rect.x0).toBeLessThan(0)
    expect(rect.x1).toBeGreaterThan(100)
    expect(rect.x0).toBeCloseTo(100 - rect.x1)
  })

  it('keeps the painting inside the box under contain and outside it under cover', () => {
    for (const aspect of SHAPES) {
      const box = { width: 100 * aspect, height: 100 }
      const contained = drawnImageRect(box, ART, 'contain')
      const covered = drawnImageRect(box, ART, 'cover')
      expect(contained.x1 - contained.x0, `${aspect}`).toBeLessThanOrEqual(100.0001)
      expect(contained.y1 - contained.y0, `${aspect}`).toBeLessThanOrEqual(100.0001)
      expect(covered.x1 - covered.x0, `${aspect}`).toBeGreaterThanOrEqual(99.9999)
      expect(covered.y1 - covered.y0, `${aspect}`).toBeGreaterThanOrEqual(99.9999)
    }
  })

  it('keeps the drawn rectangle at the aspect ratio of the art, whatever the box', () => {
    for (const aspect of SHAPES) {
      for (const fit of ['cover', 'contain'] as const) {
        const box = { width: 100 * aspect, height: 100 }
        const rect = drawnImageRect(box, ART, fit)
        const drawn =
          (((rect.x1 - rect.x0) / 100) * box.width) / (((rect.y1 - rect.y0) / 100) * box.height)
        expect(drawn, `${aspect} ${fit}`).toBeCloseTo(ART_ASPECT, 6)
      }
    }
  })

  it('falls back to the whole box for a box it cannot measure yet', () => {
    expect(drawnImageRect({ width: 0, height: 0 }, ART, 'contain')).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 100
    })
  })
})

describe('projectToBox', () => {
  it('is the identity when the box already has the aspect ratio of the art', () => {
    const box = { width: 100 * ART_ASPECT, height: 100 }
    for (const fit of ['cover', 'contain'] as const) {
      const projected = projectToBox({ x: 37, y: 71 }, box, ART, fit)
      expect(projected.x, fit).toBeCloseTo(37)
      expect(projected.y, fit).toBeCloseTo(71)
    }
  })

  /*
    The claim the whole re-anchoring rests on, checked rather than asserted: a
    point authored on the painting lands on ITS OWN PIXEL of the drawn image at
    every box shape and in both fits. Projecting to box percent, then back to
    the pixel that box percent addresses inside the drawn rectangle, has to
    return the painting pixel the point started from.

    This is the test that would have caught authoring in box percent, and the
    one that catches a fit whose maths drifts by a factor of the aspect ratio —
    a failure that looks perfectly plausible at whatever size it was eyeballed.
  */
  it('lands an authored point on its own pixel of the painting, at every box shape', () => {
    const authored = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 44.54, y: 22.5 },
      { x: 7.48, y: 95.82 }
    ]
    for (const aspect of SHAPES) {
      for (const fit of ['cover', 'contain'] as const) {
        const box = { width: 100 * aspect, height: 100 }
        const rect = drawnImageRect(box, ART, fit)
        for (const point of authored) {
          const projected = projectToBox(point, box, ART, fit)
          const where = `${aspect} ${fit} ${point.x},${point.y}`
          // Where inside the DRAWN painting that box percent falls, back in
          // painting percent. A correct projection is exactly invertible.
          expect(((projected.x - rect.x0) / (rect.x1 - rect.x0)) * 100, where).toBeCloseTo(
            point.x,
            6
          )
          expect(((projected.y - rect.y0) / (rect.y1 - rect.y0)) * 100, where).toBeCloseTo(
            point.y,
            6
          )
        }
      }
    }
  })

  /*
    The reason anchors are authored against the painting and not against the
    box: the box percent a feature sits at MOVES as the column changes shape,
    and authoring in box percent would have held it still and slid the dwarf off
    his rock.
  */
  it('tracks the same painted feature as the column changes shape', () => {
    const vein = { x: 37, y: 71 }
    // The design's own frame: 245px wide at the painting's aspect ratio, which
    // is the one column shape where `contain` has nothing left over to letterbox.
    const short = projectToBox(vein, { width: 245, height: 245 / ART_ASPECT }, ART, 'contain')
    const tall = projectToBox(vein, { width: 245, height: 1040 }, ART, 'contain')
    expect(short.x).toBeCloseTo(tall.x)
    expect(short.y).not.toBeCloseTo(tall.y)
    // The taller column letterboxes, so everything painted below the middle
    // moves UP the box as the empty bands grow.
    expect(tall.y).toBeLessThan(short.y)
  })

  it('reports a point the crop removed as outside the box, rather than lying', () => {
    // Under cover a column narrower than the art loses its side walls, so the
    // far left of the painting projects past the left edge instead of being
    // silently snapped inside it.
    const projected = projectToBox({ x: 2, y: 50 }, { width: 245, height: 1040 }, ART, 'cover')
    expect(projected.x).toBeLessThan(0)
  })

  it('hands back the authored point when the box has not been measured yet', () => {
    expect(projectToBox({ x: 37, y: 71 }, { width: 0, height: 0 }, ART, 'contain')).toEqual({
      x: 37,
      y: 71
    })
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
  The other half of the same sum `drawnImageRect` does. That one asks WHERE the
  painting is drawn; this one asks how much bigger than life it is drawn there —
  which is what a figure standing IN the painting has to be scaled by to be the
  right size next to the rock (see sceneSizing).
*/
describe('fitScale', () => {
  it('scales down to the binding axis under contain and up to it under cover', () => {
    const box = { width: 245, height: 1040 }
    // A column narrower than the art is width-bound under contain...
    expect(fitScale(box, ART, 'contain')).toBeCloseTo(245 / ART.width)
    // ...and height-bound under cover, which is what makes cover spill sideways.
    expect(fitScale(box, ART, 'cover')).toBeCloseTo(1040 / ART.height)
  })

  it('agrees with the rectangle it draws, whatever the box shape', () => {
    for (const aspect of SHAPES) {
      for (const fit of ['cover', 'contain'] as const) {
        const box = { width: 100 * aspect, height: 100 }
        const rect = drawnImageRect(box, ART, fit)
        const drawnWidth = ((rect.x1 - rect.x0) / 100) * box.width
        expect(fitScale(box, ART, fit), `${aspect} ${fit}`).toBeCloseTo(drawnWidth / ART.width, 6)
      }
    }
  })

  it('reports no scale at all for a box it cannot measure yet', () => {
    expect(fitScale({ width: 0, height: 0 }, ART, 'contain')).toBe(0)
    expect(fitScale({ width: 245, height: 749 }, { width: 0, height: 0 }, 'contain')).toBe(0)
  })
})
