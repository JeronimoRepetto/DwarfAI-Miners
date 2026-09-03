import { describe, expect, it } from 'vitest'
import type { MineTier } from '../../types'
import { INTERIOR_STATIONS } from './interiorMap'
import { INTERIOR_ROUTE, nearestOnRoute, paintingDistance } from './interiorRoute'
import {
  INTERIOR_LAYOUT,
  SCENE_ANCHOR_KINDS,
  SCENE_LAYOUTS,
  anchorPool,
  anchorsOfKind,
  clampToPainting,
  depthOrder,
  sceneLayout
} from './sceneLayout'

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen. Fifteen
 * cases went, and they went because their subject went: the concept painting
 * was one gallery seen in perspective, and everything below was about that
 * gallery's floor.
 *
 *   - The nine `CAVE_LAYOUT anchors` cases about the hand-authored anchor list:
 *     "names the painted feature every anchor sits on" (anchors are extracted
 *     now, and carry the designer's marker rather than a sentence somebody
 *     wrote), "stands every anchor a dwarf uses on the walkable floor", "puts
 *     the ore deposit off the floor", "keeps the deposit clear of every spot a
 *     dwarf can occupy", "puts the deposit outside every dwarf anchor",
 *     "leaves every occupied anchor room for a sharing pair beside the wall",
 *     "orders anchors far to near", "puts the exit at the back of the gallery"
 *     and "rests the crew in the foreground". The `deposit`, `vein`, `rest` and
 *     `exit` kinds no longer exist; the design's spatial map names spawn,
 *     worker and foreman.
 *   - Both `walkableHalfWidth` cases, both `isWalkable` cases, both
 *     `clampToBand` cases and both `depthScale` cases, with the functions
 *     themselves. A trapezoid of floor narrowing toward a tunnel mouth, and a
 *     sprite scale that grows toward the foreground, are perspective — and the
 *     production interior is drawn isometrically, as a tower of galleries where
 *     every dwarf is the same size and the walkable ground is the route network
 *     rather than a band.
 *   - "keeps every anchor a dwarf uses visible across the panel shapes the app
 *     is used at", which checked the anchors against the `cover` crop. The
 *     interior is drawn with `contain`, so nothing is ever cropped away and
 *     there is no crop to survive.
 *
 * What did NOT go with them: that every dwarf has somewhere to stand, that no
 * two of them land on the same spot, and that the scene paints near over far.
 * All three are below, against the extracted map.
 */

const TIERS: MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

/**
 * Two work spots closer than this read as one blob. The dwarf sheet is 36px
 * wide and the design draws it at 1x inside a 245px column, so a sprite is
 * about 15% of the interior's width — but the painting is three times taller
 * than wide, so the comparison has to be in painting pixels, not percent.
 */
const MIN_WORK_SPOT_PX = 120

describe('INTERIOR_LAYOUT anchors', () => {
  it('carries an anchor of every kind, so no dwarf is ever unplaceable', () => {
    for (const kind of SCENE_ANCHOR_KINDS) {
      expect(anchorsOfKind(INTERIOR_LAYOUT, kind).length, kind).toBeGreaterThan(0)
    }
  })

  it('gives every anchor a distinct id', () => {
    const ids = INTERIOR_LAYOUT.anchors.map((anchor) => anchor.id)
    expect(new Set(ids).size).toBe(INTERIOR_LAYOUT.anchors.length)
  })

  it('keeps every anchor inside the painting canvas', () => {
    for (const anchor of INTERIOR_LAYOUT.anchors) {
      expect(anchor.x, anchor.id).toBeGreaterThanOrEqual(0)
      expect(anchor.x, anchor.id).toBeLessThanOrEqual(100)
      expect(anchor.y, anchor.id).toBeGreaterThanOrEqual(0)
      expect(anchor.y, anchor.id).toBeLessThanOrEqual(100)
    }
  })

  /*
   * The design's spatial map draws five marker classes, and only three of them
   * are places anyone stands: ladders and ramps are corridor features the route
   * runs through. Taking a dwarf to one would park him mid-climb.
   */
  it('takes the three workstation classes from the map and leaves the corridor features alone', () => {
    const kinds = new Set(INTERIOR_LAYOUT.anchors.map((anchor) => anchor.kind))
    expect([...kinds].sort()).toEqual(['foreman', 'spawn', 'worker'])
    expect(INTERIOR_LAYOUT.anchors).toHaveLength(24)
    // ...and every one of them is a station the extraction actually found.
    const extracted = new Set(INTERIOR_STATIONS.map((station) => station.id))
    for (const anchor of INTERIOR_LAYOUT.anchors) {
      expect(extracted.has(anchor.id), anchor.id).toBe(true)
    }
  })

  it('keeps work spots far enough apart that two dwarfs never swing through each other', () => {
    const anchors = INTERIOR_LAYOUT.anchors
    for (const [index, anchor] of anchors.entries()) {
      for (const other of anchors.slice(index + 1)) {
        expect(
          paintingDistance(anchor, other),
          `${anchor.id} vs ${other.id}`
        ).toBeGreaterThanOrEqual(MIN_WORK_SPOT_PX)
      }
    }
  })

  /*
   * A workstation a dwarf cannot walk to is a dwarf that teleports. The design
   * drew the route line past every marker; this is the check that the
   * re-anchoring kept them together, and it is the one that would catch a
   * bridge that skewed the two datasets against each other.
   */
  it('stands every anchor within reach of a painted corridor', () => {
    for (const anchor of INTERIOR_LAYOUT.anchors) {
      // 300 painting pixels is 62 of the 1184 the painting is wide — about a
      // sprite and a half at the design's column width.
      expect(nearestOnRoute(INTERIOR_ROUTE, anchor).distance, anchor.id).toBeLessThan(300)
    }
  })

  it('turns a dwarf on the right-hand wall to face the middle of the shaft', () => {
    for (const anchor of INTERIOR_LAYOUT.anchors) {
      expect(anchor.facesLeft, anchor.id).toBe(anchor.x > 50)
    }
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
    "Each interior variant shares the same symmetric logical map; only the
    visual style changes" (screens/mine.md), confirmed by the extraction rather
    than assumed: all five panels produced identical per-class marker counts.
    The record stays per-tier so a future repaint of a single tier can diverge
    without touching a caller.
  */
  it('shares the one extracted layout across the five redressed interiors', () => {
    for (const tier of TIERS) {
      expect(sceneLayout(tier), tier).toBe(INTERIOR_LAYOUT)
    }
  })
})

describe('anchorPool', () => {
  it('hands back the anchors of the kind asked for', () => {
    const pool = anchorPool(INTERIOR_LAYOUT, 'foreman')
    expect(pool).toHaveLength(3)
    for (const anchor of pool) expect(anchor.kind).toBe('foreman')
  })

  it('stands the whole list in rather than leaving a dwarf undrawn', () => {
    const empty = { anchors: INTERIOR_LAYOUT.anchors }
    // A layout that genuinely has none of a kind cannot be built from the
    // committed map, so this asks for one via a layout filtered to spawns.
    const spawnsOnly = { anchors: anchorPool(empty, 'spawn') }
    expect(anchorPool(spawnsOnly, 'worker')).toEqual(spawnsOnly.anchors)
  })
})

describe('clampToPainting', () => {
  it('leaves a point that is already on the canvas alone', () => {
    expect(clampToPainting({ x: 40, y: 60 })).toEqual({ x: 40, y: 60 })
  })

  it('pulls a sharing offset that ran off the edge back onto it', () => {
    expect(clampToPainting({ x: -8, y: 140 })).toEqual({ x: 0, y: 100 })
  })
})

describe('depthOrder', () => {
  it('paints a dwarf on the gallery below over one above him', () => {
    expect(depthOrder(80)).toBeGreaterThan(depthOrder(70))
  })

  /*
    Modals and the map overlay already claim 90-100 (see App.vue, FeedModal),
    so scene depth has to stay in its own low band or a dwarf paints over a
    dialog.
  */
  it('stays inside a low z-index band so a dwarf never paints over a modal', () => {
    for (let y = -20; y <= 120; y++) {
      expect(depthOrder(y)).toBeGreaterThanOrEqual(10)
      expect(depthOrder(y)).toBeLessThanOrEqual(40)
      expect(Number.isInteger(depthOrder(y))).toBe(true)
    }
  })
})
