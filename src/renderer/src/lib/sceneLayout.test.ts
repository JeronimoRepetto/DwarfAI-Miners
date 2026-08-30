import { describe, expect, it } from 'vitest'
import type { MineTier } from '../types'
import { SHARE_SPREAD_X } from './sceneAssignment'
import { visibleImageRect } from './sceneGeometry'
import {
  CAVE_LAYOUT,
  SCENE_ANCHOR_KINDS,
  SCENE_LAYOUTS,
  anchorsOfKind,
  clampToBand,
  depthOrder,
  depthScale,
  isWalkable,
  sceneLayout,
  walkableHalfWidth
} from './sceneLayout'

const TIERS: MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

/**
 * Two work spots closer than this read as one blob: the dwarf art paints
 * roughly 12 units of image width once its transparent margin is discounted.
 */
const MIN_WORK_SPOT_DISTANCE = 15

describe('CAVE_LAYOUT anchors', () => {
  it('authors at least one anchor of every kind, so no dwarf is ever unplaceable', () => {
    for (const kind of SCENE_ANCHOR_KINDS) {
      expect(anchorsOfKind(CAVE_LAYOUT, kind).length, kind).toBeGreaterThan(0)
    }
  })

  it('gives every anchor a distinct id', () => {
    const ids = CAVE_LAYOUT.anchors.map((anchor) => anchor.id)
    expect(new Set(ids).size).toBe(CAVE_LAYOUT.anchors.length)
  })

  it('names the painted feature every anchor sits on', () => {
    for (const anchor of CAVE_LAYOUT.anchors) {
      expect(anchor.feature.length, anchor.id).toBeGreaterThan(10)
    }
  })

  it('keeps every anchor inside the painting canvas', () => {
    for (const anchor of CAVE_LAYOUT.anchors) {
      expect(anchor.x, anchor.id).toBeGreaterThanOrEqual(0)
      expect(anchor.x, anchor.id).toBeLessThanOrEqual(100)
      expect(anchor.y, anchor.id).toBeGreaterThanOrEqual(0)
      expect(anchor.y, anchor.id).toBeLessThanOrEqual(100)
    }
  })

  it('stands every anchor on the walkable floor rather than in the air or in a wall', () => {
    for (const anchor of CAVE_LAYOUT.anchors) {
      expect(isWalkable(CAVE_LAYOUT.band, anchor), anchor.id).toBe(true)
    }
  })

  it('keeps work spots far enough apart that two dwarfs never swing through each other', () => {
    const veins = anchorsOfKind(CAVE_LAYOUT, 'vein')
    expect(veins.length).toBeGreaterThanOrEqual(3)
    for (const [index, vein] of veins.entries()) {
      for (const other of veins.slice(index + 1)) {
        const distance = Math.hypot(vein.x - other.x, vein.y - other.y)
        expect(distance, `${vein.id} vs ${other.id}`).toBeGreaterThanOrEqual(MIN_WORK_SPOT_DISTANCE)
      }
    }
  })

  /*
    Anchors dwarfs actually stand on have to leave room for a second dwarf to
    share them, or `assignScene` clamps the overflow into the rock wall and the
    pair collapses back onto one spot. The ore pile is exempt: nobody stands on
    it.
  */
  it('leaves every occupied anchor room for a sharing pair beside the wall', () => {
    const occupied = CAVE_LAYOUT.anchors.filter((anchor) => anchor.kind !== 'deposit')
    for (const anchor of occupied) {
      const clearance = walkableHalfWidth(CAVE_LAYOUT.band, anchor.y) - SHARE_SPREAD_X / 2
      expect(Math.abs(anchor.x - CAVE_LAYOUT.band.centerX), anchor.id).toBeLessThanOrEqual(
        clearance
      )
    }
  })

  it('orders anchors far to near (y ascending) so painting in order reads as depth', () => {
    const ys = CAVE_LAYOUT.anchors.map((anchor) => anchor.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
  })

  it('puts the exit at the back of the gallery, farther than every spot dwarfs work', () => {
    const exits = anchorsOfKind(CAVE_LAYOUT, 'exit')
    const veins = anchorsOfKind(CAVE_LAYOUT, 'vein')
    expect(exits.length).toBeGreaterThan(0)
    for (const exit of exits) {
      for (const vein of veins) {
        expect(exit.y, `${exit.id} vs ${vein.id}`).toBeLessThan(vein.y)
      }
    }
  })

  it('rests the crew in the foreground, nearer than the veins they were working', () => {
    const farthestRest = Math.min(...anchorsOfKind(CAVE_LAYOUT, 'rest').map((a) => a.y))
    const nearestVein = Math.max(...anchorsOfKind(CAVE_LAYOUT, 'vein').map((a) => a.y))
    expect(farthestRest).toBeGreaterThan(nearestVein)
  })
})

describe('SCENE_LAYOUTS', () => {
  it('resolves a layout for every tier', () => {
    for (const tier of TIERS) {
      expect(sceneLayout(tier), tier).toBe(SCENE_LAYOUTS[tier])
      expect(sceneLayout(tier).anchors.length, tier).toBeGreaterThan(0)
    }
  })

  /*
    The five interiors are one painting redressed per tier — identical rock,
    timber and tunnel, only the ore colour changes — so they share one layout
    on purpose. The map stays per-tier so a future repaint of a single tier can
    diverge without touching a caller.
  */
  it('shares the one authored layout across the five redressed interiors', () => {
    for (const tier of TIERS) {
      expect(sceneLayout(tier), tier).toBe(CAVE_LAYOUT)
    }
  })
})

describe('walkableHalfWidth', () => {
  it('narrows toward the back of the gallery, because the tunnel does', () => {
    const { band } = CAVE_LAYOUT
    expect(walkableHalfWidth(band, band.farY)).toBeCloseTo(band.farHalfWidth)
    expect(walkableHalfWidth(band, band.nearY)).toBeCloseTo(band.nearHalfWidth)
    expect(walkableHalfWidth(band, (band.farY + band.nearY) / 2)).toBeCloseTo(
      (band.farHalfWidth + band.nearHalfWidth) / 2
    )
  })

  it('clamps beyond both ends rather than extrapolating off the floor', () => {
    const { band } = CAVE_LAYOUT
    expect(walkableHalfWidth(band, 0)).toBeCloseTo(band.farHalfWidth)
    expect(walkableHalfWidth(band, 100)).toBeCloseTo(band.nearHalfWidth)
  })
})

describe('isWalkable', () => {
  it('rejects a point above the back of the floor or below its front edge', () => {
    const { band } = CAVE_LAYOUT
    expect(isWalkable(band, { x: 50, y: band.farY - 1 })).toBe(false)
    expect(isWalkable(band, { x: 50, y: band.nearY + 1 })).toBe(false)
  })

  it('rejects a point out past the rock wall at that depth', () => {
    const { band } = CAVE_LAYOUT
    const y = band.farY
    expect(isWalkable(band, { x: band.centerX + band.farHalfWidth + 1, y })).toBe(false)
    expect(isWalkable(band, { x: band.centerX - band.farHalfWidth - 1, y })).toBe(false)
  })
})

describe('clampToBand', () => {
  it('pulls a stray point back onto the floor at its own depth', () => {
    const { band } = CAVE_LAYOUT
    const clamped = clampToBand(band, { x: 5, y: band.farY })
    expect(clamped.y).toBe(band.farY)
    expect(clamped.x).toBeCloseTo(band.centerX - band.farHalfWidth)
    expect(isWalkable(band, clamped)).toBe(true)
  })

  it('leaves a point that is already on the floor untouched', () => {
    const { band } = CAVE_LAYOUT
    expect(clampToBand(band, { x: 50, y: 80 })).toEqual({ x: 50, y: 80 })
  })
})

describe('depthScale', () => {
  it('grows toward the foreground so the perspective of the painting survives', () => {
    const { band } = CAVE_LAYOUT
    expect(depthScale(band, band.farY)).toBeCloseTo(band.farScale)
    expect(depthScale(band, band.nearY)).toBeCloseTo(band.nearScale)
    expect(depthScale(band, 75)).toBeGreaterThan(depthScale(band, 70))
  })

  it('stays within a believable range, never shrinking a dwarf to a speck', () => {
    const { band } = CAVE_LAYOUT
    for (let y = 0; y <= 100; y++) {
      expect(depthScale(band, y)).toBeGreaterThanOrEqual(0.7)
      expect(depthScale(band, y)).toBeLessThanOrEqual(1.15)
    }
  })
})

describe('depthOrder', () => {
  it('paints a nearer dwarf over a farther one', () => {
    const { band } = CAVE_LAYOUT
    expect(depthOrder(band, 80)).toBeGreaterThan(depthOrder(band, 70))
  })

  /*
    Modals and the map overlay already claim 90-100 (see App.vue, FeedModal),
    so scene depth has to stay in its own low band or a dwarf paints over a
    dialog.
  */
  it('stays inside a low z-index band so a dwarf never paints over a modal', () => {
    const { band } = CAVE_LAYOUT
    for (let y = 0; y <= 100; y++) {
      expect(depthOrder(band, y)).toBeGreaterThanOrEqual(10)
      expect(depthOrder(band, y)).toBeLessThanOrEqual(40)
      expect(Number.isInteger(depthOrder(band, y))).toBe(true)
    }
  })
})

/*
  The painting is drawn with `object-fit: cover; object-position: 50% 100%`, so
  the visible window is always the BOTTOM of the art and how much of it shows
  depends on the panel's shape. Unlike the map, whose crop contracts toward the
  centre, this one is pinned to the floor: authored anchors have to survive the
  panel shapes the app is actually dragged into.
*/
describe('anchors against the cover crop', () => {
  const ART = { width: 1289, height: 1600 }

  it('keeps every anchor visible across the panel shapes the app is used at', () => {
    for (const aspect of [0.6, 0.75, 0.9, 1.1, 1.3, 1.6]) {
      const rect = visibleImageRect({ width: 100 * aspect, height: 100 }, ART)
      for (const anchor of CAVE_LAYOUT.anchors) {
        expect(anchor.x, `${anchor.id} @ ${aspect}`).toBeGreaterThanOrEqual(rect.x0)
        expect(anchor.x, `${anchor.id} @ ${aspect}`).toBeLessThanOrEqual(rect.x1)
        expect(anchor.y, `${anchor.id} @ ${aspect}`).toBeGreaterThanOrEqual(rect.y0)
        expect(anchor.y, `${anchor.id} @ ${aspect}`).toBeLessThanOrEqual(rect.y1)
      }
    }
  })
})
