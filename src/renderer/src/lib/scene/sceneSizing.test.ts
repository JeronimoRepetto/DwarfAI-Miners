import { describe, expect, it } from 'vitest'
import { INTERIOR_ART_SIZE } from '../art'
import { SPRITE_FRAME_SIZE } from '../sprite/spriteSheet'
import { drawnImageRect } from './sceneGeometry'
import { INTERIOR_LAYOUT } from './sceneLayout'
import { INTERIOR_PAINTING_SIZE } from './interiorMap'
import {
  AUTHORED_INTERIOR_BOX,
  DESIGN_INTERIOR_WIDTH,
  DWARF_PAINTING_HEIGHT,
  INTERIOR_FIT,
  spriteFootprintPx,
  spriteHeightPx,
  spriteMarginPercent
} from './sceneSizing'

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen. Fifteen
 * cases went with their subjects:
 *
 *   - `describe('CAVE_ART_SIZE')`'s one case. sceneSizing no longer keeps a
 *     copy of the painting's pixel size: it reads `INTERIOR_PAINTING_SIZE` from
 *     `interiorMap`, which is plain TypeScript with no asset imports, so the
 *     reason the copy existed (the main-process project cannot resolve art.ts)
 *     is gone. The two-are-equal check it enforced did not go with it — it
 *     moved to `interiorMap.test.ts`, which holds `INTERIOR_PAINTING_SIZE`
 *     against art.ts's `INTERIOR_ART_SIZE`.
 *   - All four `AUTHORED_SPRITE` cases, with the constant. The scene's
 *     calibration is no longer "100px in a 428x512 cave" but the design's own
 *     "one 36x38 sheet frame at 1x in a 245px column", so there is no authored
 *     sprite box to keep a shape and a height for — `DWARF_PAINTING_HEIGHT`
 *     below is what replaced it, and the shape follows `SPRITE_FRAME_SIZE`
 *     directly.
 *   - All seven `SMALLEST_READABLE_CAVE_BOX` and `MIN_PANEL_SIZE` cases, with
 *     `anchorsFitCaveBox`, `smallestReadableCaveWidth`, `CAVE_MIN_WIDTH_PX`,
 *     `CAVE_MIN_HEIGHT_PX`, `AUTHORED_PANEL_SIZE`, `AUTHORED_CAVE_BOX` and
 *     `PANEL_CHROME`. They computed the narrowest panel in which the `cover`
 *     crop still left every anchor on screen. The panel is docked and no longer
 *     draggable (#90), and the interior is drawn with `contain`, so nothing is
 *     ever cropped at any shape and there is no floor left to compute. The one
 *     guarantee worth keeping — that the crop never steals a workstation — is
 *     below as "keeps every workstation on screen at every column shape", and
 *     it now holds at ALL shapes rather than above a computed width.
 *   - Three of the four `spriteHeightPx` cases and both `spriteFootprintPx`
 *     cases were rewritten rather than removed: same subject, new calibration.
 */

describe('INTERIOR_FIT', () => {
  it('contains the painting rather than covering the column', () => {
    expect(INTERIOR_FIT).toBe('contain')
  })

  /*
   * The argument for that choice, as an assertion. A docked column is 245px
   * wide and the height of the display; `cover` would scale the painting to
   * that height and push roughly a quarter of its width off both sides, taking
   * the outermost work points with it. This is the test that would fail if
   * somebody "fixed" the letterbox by switching to cover.
   */
  it('keeps every workstation on screen at every column shape', () => {
    for (const height of [400, 749, 1040, 1440, 2160]) {
      const box = { width: DESIGN_INTERIOR_WIDTH, height }
      const rect = drawnImageRect(box, INTERIOR_PAINTING_SIZE, INTERIOR_FIT)
      expect(rect.x0, `${height}`).toBeGreaterThanOrEqual(0)
      expect(rect.x1, `${height}`).toBeLessThanOrEqual(100)
      expect(rect.y0, `${height}`).toBeGreaterThanOrEqual(0)
      expect(rect.y1, `${height}`).toBeLessThanOrEqual(100)
    }
  })

  it('would lose the outermost workstations if it covered instead', () => {
    // A full-screen-height column, which is what the docked panel actually is.
    const covered = drawnImageRect(
      { width: DESIGN_INTERIOR_WIDTH, height: 1040 },
      INTERIOR_PAINTING_SIZE,
      'cover'
    )
    const leftmost = Math.min(...INTERIOR_LAYOUT.anchors.map((anchor) => anchor.x))
    const projected = covered.x0 + (leftmost / 100) * (covered.x1 - covered.x0)
    expect(projected).toBeLessThan(0)
  })
})

/*
 * Issue #44 — a dwarf was drawn at a hard-coded 100px whatever the panel was
 * doing, so a panel dragged small held the same sprites in less room instead of
 * the same scene. He is a figure IN the painting, so his height has to follow
 * the painting's own fit scale: the rock he stands next to is scaled by exactly
 * that factor, and he has to be scaled with it.
 *
 * Issue #137 settled the factor itself, which #44 had only ever calibrated
 * against the concept cave.
 */
describe('spriteHeightPx', () => {
  /*
   * The whole scale decision in one line. `screens/mine.md` draws the sheet
   * frames at 1x inside a 245px interior, so at the design's own column a dwarf
   * is exactly one frame tall — 38px, against the 100px the cave drew him at.
   */
  it('draws a dwarf at one sheet frame in the column the design gives it', () => {
    expect(spriteHeightPx(AUTHORED_INTERIOR_BOX)).toBeCloseTo(SPRITE_FRAME_SIZE.height)
    // ...which is the 2.6x the cave was too big by, stated rather than implied.
    expect(100 / spriteHeightPx(AUTHORED_INTERIOR_BOX)).toBeCloseTo(2.63, 1)
  })

  it('is that height measured in painting pixels, scaled by the painting', () => {
    for (const box of [
      { width: 123, height: 376 },
      AUTHORED_INTERIOR_BOX,
      { width: 245, height: 1040 },
      { width: 490, height: 1498 }
    ]) {
      const scale = Math.min(
        box.width / INTERIOR_PAINTING_SIZE.width,
        box.height / INTERIOR_PAINTING_SIZE.height
      )
      expect(spriteHeightPx(box), `${box.width}x${box.height}`).toBeCloseTo(
        DWARF_PAINTING_HEIGHT * scale
      )
    }
  })

  it('shrinks the crew with the column instead of holding them at a fixed size', () => {
    const half = spriteHeightPx({ width: 123, height: 376 })
    const authored = spriteHeightPx(AUTHORED_INTERIOR_BOX)
    const double = spriteHeightPx({ width: 490, height: 1498 })
    expect(half).toBeLessThan(authored)
    expect(double).toBeGreaterThan(authored)
  })

  /*
   * A column taller than the painting's shape is width-bound under contain, so
   * the sprite tracks the WIDTH alone — which is what keeps the crew the same
   * size on a 1080p display and a 1440p one, where only the height differs.
   */
  it('ignores height once the column is taller than the painting', () => {
    expect(spriteHeightPx({ width: 245, height: 1040 })).toBeCloseTo(
      spriteHeightPx({ width: 245, height: 2160 })
    )
  })

  /*
   * Same convention as drawnImageRect: an unmeasured box is "no measurement
   * yet", never "a mine of no size", so the design's own 1x height stands in
   * until a real ResizeObserver reading arrives.
   */
  it('falls back to the design height for a box it cannot measure yet', () => {
    expect(spriteHeightPx({ width: 0, height: 0 })).toBe(SPRITE_FRAME_SIZE.height)
    expect(spriteHeightPx(AUTHORED_INTERIOR_BOX, { width: 0, height: 0 })).toBe(
      SPRITE_FRAME_SIZE.height
    )
  })
})

describe('DWARF_PAINTING_HEIGHT', () => {
  it('is the frame height scaled back up by how far the painting is scaled down', () => {
    expect(DWARF_PAINTING_HEIGHT).toBeCloseTo(
      (SPRITE_FRAME_SIZE.height * INTERIOR_PAINTING_SIZE.width) / DESIGN_INTERIOR_WIDTH
    )
    expect(DWARF_PAINTING_HEIGHT).toBeCloseTo(183.6, 1)
  })

  it('takes the design column width the tokens actually publish', () => {
    // --size-mine-interior-width in assets/design-tokens.css, and the 245px
    // screens/mine.md states in as many words.
    expect(DESIGN_INTERIOR_WIDTH).toBe(245)
  })
})

describe('AUTHORED_INTERIOR_BOX', () => {
  it('is the design column at the painting own aspect ratio, so nothing letterboxes', () => {
    expect(AUTHORED_INTERIOR_BOX.width).toBe(DESIGN_INTERIOR_WIDTH)
    const rect = drawnImageRect(AUTHORED_INTERIOR_BOX, INTERIOR_PAINTING_SIZE, INTERIOR_FIT)
    expect(rect.x0).toBeCloseTo(0)
    expect(rect.y0).toBeCloseTo(0)
    expect(rect.x1).toBeCloseTo(100)
    expect(rect.y1).toBeCloseTo(100)
  })
})

/**
 * The painting's pixel size still belongs to art.ts, which is what the renderer
 * actually loads. `interiorMap` carries its own copy because the coordinates
 * are percentages OF it; this is the check that keeps the two the same file.
 */
describe('INTERIOR_PAINTING_SIZE', () => {
  it('is the same painting art.ts actually renders', () => {
    expect(INTERIOR_PAINTING_SIZE).toEqual({
      width: INTERIOR_ART_SIZE.width,
      height: INTERIOR_ART_SIZE.height
    })
  })
})

describe('spriteFootprintPx', () => {
  it('keeps the shape of the frame the dwarfs are actually drawn in', () => {
    for (const box of [
      AUTHORED_INTERIOR_BOX,
      { width: 123, height: 376 },
      { width: 245, height: 1440 }
    ]) {
      const footprint = spriteFootprintPx(box)
      expect(footprint.width / footprint.height, `${box.width}x${box.height}`).toBeCloseTo(
        SPRITE_FRAME_SIZE.width / SPRITE_FRAME_SIZE.height
      )
    }
  })

  it('is exactly one sheet frame at the design column', () => {
    const footprint = spriteFootprintPx(AUTHORED_INTERIOR_BOX)
    expect(footprint.width).toBeCloseTo(SPRITE_FRAME_SIZE.width)
    expect(footprint.height).toBeCloseTo(SPRITE_FRAME_SIZE.height)
  })

  /*
   * The sanity check on the whole scale decision, in the units a reader can
   * picture: a dwarf takes about a seventh of the column's width. The cave's
   * 100px sprite in a 245px column would have taken well over a third of it,
   * which is what "too big" looked like.
   */
  it('leaves a dwarf about a seventh of the column wide', () => {
    const footprint = spriteFootprintPx(AUTHORED_INTERIOR_BOX)
    expect(footprint.width / AUTHORED_INTERIOR_BOX.width).toBeCloseTo(0.147, 2)
  })
})

describe('spriteMarginPercent', () => {
  it('reserves half a drawn sprite at each side, in the column own percent', () => {
    const margin = spriteMarginPercent(AUTHORED_INTERIOR_BOX)
    const footprint = spriteFootprintPx(AUTHORED_INTERIOR_BOX)
    expect(margin.x).toBeCloseTo((50 * footprint.width) / AUTHORED_INTERIOR_BOX.width)
    expect(margin.y).toBe(4)
  })

  it('falls back to the design column for a box it cannot measure yet', () => {
    expect(spriteMarginPercent({ width: 0, height: 0 })).toEqual(
      spriteMarginPercent(AUTHORED_INTERIOR_BOX)
    )
  })
})
