import { describe, expect, it } from 'vitest'
import { INTERIOR_ART_SIZE } from './art'
import { projectToBox, visibleImageRect, type BoxSize } from './sceneGeometry'
import { CAVE_LAYOUT, depthScale, type SceneAnchor } from './sceneLayout'
import {
  AUTHORED_CAVE_BOX,
  AUTHORED_PANEL_SIZE,
  AUTHORED_SPRITE,
  CAVE_ART_SIZE,
  CAVE_MIN_HEIGHT_PX,
  MIN_PANEL_SIZE,
  PANEL_CHROME,
  SMALLEST_READABLE_CAVE_BOX,
  anchorsFitCaveBox,
  spriteFootprintPx,
  spriteHeightPx
} from './sceneSizing'

/**
 * The painting's own pixel size is owned by art.ts, but sceneSizing cannot
 * import it: the window minimum is derived from these numbers and
 * `src/main/window.test.ts` re-derives it, which would drag art.ts's asset
 * imports into the main-process TypeScript project (no `vite/client` types
 * there). The copy is safe only for as long as this test holds the two equal.
 */
describe('CAVE_ART_SIZE', () => {
  it('is the same painting art.ts actually renders', () => {
    expect(CAVE_ART_SIZE).toEqual({
      width: INTERIOR_ART_SIZE.width,
      height: INTERIOR_ART_SIZE.height
    })
  })
})

/*
 * Issue #44 — a dwarf was drawn at a hard-coded 100px whatever the panel was
 * doing, so a panel dragged small held the same sprites in less room instead of
 * the same scene. He is a figure IN the painting, so his height has to follow
 * the painting's own `object-fit: cover` scale: the rock he stands next to is
 * blown up by exactly that factor, and he has to be blown up with it.
 */
describe('spriteHeightPx', () => {
  it('draws the authored 100px at the cave box the sprite was authored against', () => {
    expect(spriteHeightPx(AUTHORED_CAVE_BOX, CAVE_ART_SIZE)).toBeCloseTo(AUTHORED_SPRITE.height)
  })

  it('tracks the cover scale of the painting, not either edge of the box on its own', () => {
    for (const box of [
      { width: 214, height: 256 },
      { width: 428, height: 512 },
      { width: 856, height: 1024 },
      { width: 900, height: 400 },
      { width: 300, height: 900 }
    ]) {
      const cover = Math.max(box.width / CAVE_ART_SIZE.width, box.height / CAVE_ART_SIZE.height)
      const authoredCover = Math.max(
        AUTHORED_CAVE_BOX.width / CAVE_ART_SIZE.width,
        AUTHORED_CAVE_BOX.height / CAVE_ART_SIZE.height
      )
      expect(spriteHeightPx(box, CAVE_ART_SIZE), `${box.width}x${box.height}`).toBeCloseTo(
        AUTHORED_SPRITE.height * (cover / authoredCover)
      )
    }
  })

  it('shrinks the crew with the panel instead of holding them at a fixed size', () => {
    const half = spriteHeightPx({ width: 214, height: 256 }, CAVE_ART_SIZE)
    const authored = spriteHeightPx(AUTHORED_CAVE_BOX, CAVE_ART_SIZE)
    const double = spriteHeightPx({ width: 856, height: 1024 }, CAVE_ART_SIZE)
    expect(half).toBeLessThan(authored)
    expect(double).toBeGreaterThan(authored)
  })

  /*
   * Same convention as visibleImageRect: an unmeasured box is "no measurement
   * yet", never "a cave of no size", so the authored height stands in until a
   * real ResizeObserver reading arrives.
   */
  it('falls back to the authored height for a box it cannot measure yet', () => {
    expect(spriteHeightPx({ width: 0, height: 0 }, CAVE_ART_SIZE)).toBe(AUTHORED_SPRITE.height)
    expect(spriteHeightPx({ width: 428, height: 512 }, { width: 0, height: 0 })).toBe(
      AUTHORED_SPRITE.height
    )
  })
})

describe('spriteFootprintPx', () => {
  it('keeps the authored width-to-height ratio of the shared pose canvas', () => {
    for (const box of [
      AUTHORED_CAVE_BOX,
      { width: 244, height: 320 },
      { width: 900, height: 400 }
    ]) {
      const footprint = spriteFootprintPx(box, CAVE_ART_SIZE)
      expect(footprint.width / footprint.height, `${box.width}x${box.height}`).toBeCloseTo(
        AUTHORED_SPRITE.width / AUTHORED_SPRITE.height
      )
    }
  })

  it('is the authored 96x100 box at the authored cave box', () => {
    const footprint = spriteFootprintPx(AUTHORED_CAVE_BOX, CAVE_ART_SIZE)
    expect(footprint.width).toBeCloseTo(AUTHORED_SPRITE.width)
    expect(footprint.height).toBeCloseTo(AUTHORED_SPRITE.height)
  })
})

/*
 * The floor under the panel.
 *
 * Nothing here is picked by eye. The cave already declares its own vertical
 * floor (`.cave { min-height }`), and the horizontal one falls out of the crop:
 * `object-fit: cover` eats the side walls of a box narrower than the art, and
 * the authored anchors are glued to painted features, so past some narrowness
 * the outermost anchor is cropped away and the dwarf standing on it gets held
 * at the panel edge instead of standing on his rock.
 */
describe('SMALLEST_READABLE_CAVE_BOX', () => {
  const dwarfAnchors = CAVE_LAYOUT.anchors.filter((anchor) => anchor.kind !== 'deposit')

  it('is the cave floor the scene already declares, at the narrowest width that still reads', () => {
    expect(SMALLEST_READABLE_CAVE_BOX.height).toBe(CAVE_MIN_HEIGHT_PX)
    expect(SMALLEST_READABLE_CAVE_BOX.width).toBe(244)
  })

  it('keeps every authored anchor inside the visible crop', () => {
    const rect = visibleImageRect(SMALLEST_READABLE_CAVE_BOX, CAVE_ART_SIZE)
    for (const anchor of CAVE_LAYOUT.anchors) {
      expect(anchor.x, anchor.id).toBeGreaterThanOrEqual(rect.x0)
      expect(anchor.x, anchor.id).toBeLessThanOrEqual(rect.x1)
      expect(anchor.y, anchor.id).toBeGreaterThanOrEqual(rect.y0)
      expect(anchor.y, anchor.id).toBeLessThanOrEqual(rect.y1)
    }
  })

  it('leaves every anchor a whole sprite footprint clear of the panel edge', () => {
    expect(anchorsFitCaveBox(SMALLEST_READABLE_CAVE_BOX, CAVE_ART_SIZE, CAVE_LAYOUT)).toBe(true)
  })

  /*
    The minimum is the boundary itself, not a comfortable number near it: one
    pixel narrower and an anchor has to be clamped to the edge. That is what
    makes it derived rather than guessed, and it is what would fail loudly if
    an anchor were re-authored further into a corner.
  */
  it('is tight — one pixel narrower and an anchor no longer fits', () => {
    const narrower = {
      width: SMALLEST_READABLE_CAVE_BOX.width - 1,
      height: SMALLEST_READABLE_CAVE_BOX.height
    }
    expect(anchorsFitCaveBox(narrower, CAVE_ART_SIZE, CAVE_LAYOUT)).toBe(false)
  })

  /** The drawn box of one dwarf, in cave pixels, standing with his feet on `anchor`. */
  function spriteBoxAt(anchor: SceneAnchor, box: BoxSize) {
    const point = projectToBox(anchor, box, CAVE_ART_SIZE)
    const footprint = spriteFootprintPx(box, CAVE_ART_SIZE)
    const scale = depthScale(CAVE_LAYOUT.band, anchor.y)
    const centerX = (point.x / 100) * box.width
    const feet = (1 - point.y / 100) * box.height
    return {
      left: centerX - (footprint.width * scale) / 2,
      right: centerX + (footprint.width * scale) / 2,
      bottom: feet,
      top: feet + footprint.height * scale
    }
  }

  /*
    Dwarfs at DIFFERENT depths are allowed to overlap — that is what the
    perspective and the z-index sorting are for, a nearer miner occluding a
    farther one. Two at the SAME depth have no such excuse: nothing separates
    them, so they must stand clear of each other.
  */
  it('keeps same-depth occupied anchors from overlapping once footprints are counted', () => {
    for (const box of [SMALLEST_READABLE_CAVE_BOX, AUTHORED_CAVE_BOX]) {
      for (const a of dwarfAnchors) {
        for (const b of dwarfAnchors) {
          if (a.id >= b.id || Math.abs(a.y - b.y) > 1) continue
          const left = spriteBoxAt(a, box)
          const right = spriteBoxAt(b, box)
          const overlaps =
            left.left < right.right &&
            right.left < left.right &&
            left.bottom < right.top &&
            right.bottom < left.top
          expect(overlaps, `${a.id} vs ${b.id} at ${box.width}x${box.height}`).toBe(false)
        }
      }
    }
  })
})

/*
 * What main actually needs: the panel size, which is the cave box plus the
 * chrome that surrounds it. The chrome is not measured or guessed either — it
 * is the difference between the two authored pairs, the 460x600 panel and the
 * 428x512 cave that panel produces.
 */
describe('MIN_PANEL_SIZE', () => {
  it('is the smallest readable cave plus the chrome around it', () => {
    expect(PANEL_CHROME).toEqual({
      width: AUTHORED_PANEL_SIZE.width - AUTHORED_CAVE_BOX.width,
      height: AUTHORED_PANEL_SIZE.height - AUTHORED_CAVE_BOX.height
    })
    expect(MIN_PANEL_SIZE).toEqual({
      width: SMALLEST_READABLE_CAVE_BOX.width + PANEL_CHROME.width,
      height: SMALLEST_READABLE_CAVE_BOX.height + PANEL_CHROME.height
    })
  })

  it('is the 276x408 the authored scene derives to today', () => {
    expect(MIN_PANEL_SIZE).toEqual({ width: 276, height: 408 })
  })

  it('is a floor the shipped default panel is comfortably above', () => {
    expect(AUTHORED_PANEL_SIZE.width).toBeGreaterThan(MIN_PANEL_SIZE.width)
    expect(AUTHORED_PANEL_SIZE.height).toBeGreaterThan(MIN_PANEL_SIZE.height)
  })
})
