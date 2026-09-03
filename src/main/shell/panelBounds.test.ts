import { describe, expect, it } from 'vitest'
import {
  DESIGN_INTERIOR_WIDTH,
  interiorColumnWidth
} from '../../renderer/src/lib/scene/sceneSizing'
import {
  DESIGN_COMPOSITION_HEIGHT,
  DESIGN_SECONDARY_WIDTH,
  MIN_WINDOW_WIDTH,
  RAIL_WIDTH,
  expandedWidth,
  mineColumnWidth,
  panelBounds,
  panelWidth,
  secondaryColumnWidth
} from './panelBounds'

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }

const CLOSED = { expanded: false, mineOpen: false }
const OPEN = { expanded: true, mineOpen: false }
const OPEN_WITH_MINE = { expanded: true, mineOpen: true }

/*
 * AMENDED for the acceptance ruling (#153). Four cases in this describe block
 * asserted against the FIXED constants `EXPANDED_WIDTH` and `MINE_COLUMN_WIDTH`
 * — "opens to the derived panel width", "adds the mine column when a mine is
 * held open beside the secondary panel", "leaves a display that fits the
 * composition alone", and the closed-rail case's use of them. Both constants
 * are gone: every column is now DERIVED from the display's own height, because
 * both paintings are fitted to the full height of the shell's content area with
 * their aspect preserved. The cases below assert the same behaviours against
 * the derivations that replaced them, so nothing they covered is unwatched.
 */
describe('panelWidth', () => {
  it('is the closed rail while closed, whether or not a mine is held open', () => {
    // The design's rail is 20px and the renderer still draws exactly that; the
    // WINDOW is the platform's 32px floor, because Windows will not make one
    // narrower and asking for 20 docks differently on each edge (see below).
    expect(panelWidth(AREA, CLOSED)).toBe(MIN_WINDOW_WIDTH)
    expect(panelWidth(AREA, { expanded: false, mineOpen: true })).toBe(MIN_WINDOW_WIDTH)
    expect(RAIL_WIDTH).toBeLessThan(MIN_WINDOW_WIDTH)
  })

  it('opens to the width the display’s own height derives', () => {
    expect(panelWidth(AREA, OPEN)).toBe(expandedWidth(AREA.height))
  })

  it('adds the mine column when a mine is held open beside the secondary panel', () => {
    expect(panelWidth(AREA, OPEN_WITH_MINE)).toBe(
      expandedWidth(AREA.height) + mineColumnWidth(AREA.height)
    )
  })

  it('never asks for more width than the display has', () => {
    // Narrower than the design's own composition, which the source does not
    // cover: the panel spans the display rather than hanging off the side.
    const narrow = { x: 0, y: 0, width: 480, height: 600 }
    expect(panelWidth(narrow, OPEN)).toBe(480)
    expect(panelWidth(narrow, OPEN_WITH_MINE)).toBe(480)
    // The rail is smaller than any display, so it is never clamped.
    expect(panelWidth(narrow, CLOSED)).toBe(MIN_WINDOW_WIDTH)
  })

  it('grows with the display, because both paintings follow its height', () => {
    const short = { x: 0, y: 0, width: 3840, height: 768 }
    const tall = { x: 0, y: 0, width: 3840, height: 1392 }
    expect(panelWidth(tall, OPEN)).toBeGreaterThan(panelWidth(short, OPEN))
    expect(panelWidth(tall, OPEN_WITH_MINE)).toBeGreaterThan(panelWidth(short, OPEN_WITH_MINE))
  })
})

/*
 * The one fit rule, on the main-process side (#153). Both paintings are drawn
 * at the FULL HEIGHT of the shell's content area with their aspect preserved
 * and nothing cropped, so the width of the column that holds one is derived
 * from the display's height rather than transcribed. main's part is reserving
 * that width in the window; the renderer draws into it (sceneSizing, MapView).
 */
describe('the derived columns', () => {
  it('reproduces the design’s own 245px interior at the design’s own 768-tall composition', () => {
    // The design never stated 245 as a constant: it is this rule evaluated at
    // the composition's own height, which is why it is checked rather than
    // copied. One pixel of rounding is the whole disagreement.
    expect(mineColumnWidth(DESIGN_COMPOSITION_HEIGHT)).toBeCloseTo(DESIGN_INTERIOR_WIDTH + 8, -0.5)
  })

  it('reserves exactly the interior column the renderer draws, plus the gap beside it', () => {
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1032, 1392, 2160]) {
      expect(mineColumnWidth(height) - 8).toBe(interiorColumnWidth(height))
    }
  })

  it('never squeezes the secondary column below the design’s own content width', () => {
    expect(secondaryColumnWidth(200)).toBe(DESIGN_SECONDARY_WIDTH)
    expect(secondaryColumnWidth(DESIGN_COMPOSITION_HEIGHT)).toBeGreaterThan(DESIGN_SECONDARY_WIDTH)
  })

  it('spends the opened width on the design’s own chrome plus that column', () => {
    for (const height of [DESIGN_COMPOSITION_HEIGHT, 1392]) {
      expect(expandedWidth(height) - secondaryColumnWidth(height)).toBe(90)
    }
  })

  it('returns whole pixels, because Electron bounds take nothing else', () => {
    for (const height of [601, 769, 1033, 1393]) {
      expect(Number.isInteger(mineColumnWidth(height))).toBe(true)
      expect(Number.isInteger(secondaryColumnWidth(height))).toBe(true)
      expect(Number.isInteger(expandedWidth(height))).toBe(true)
    }
  })
})

describe('panelBounds', () => {
  it('hangs the closed rail on the right edge by default', () => {
    expect(panelBounds(AREA, 'right', CLOSED)).toEqual({
      x: 1920 - MIN_WINDOW_WIDTH,
      y: 0,
      width: MIN_WINDOW_WIDTH,
      height: 1032
    })
  })

  it('hangs the closed rail on the left edge when that is the docked side', () => {
    expect(panelBounds(AREA, 'left', CLOSED)).toEqual({
      x: 0,
      y: 0,
      width: MIN_WINDOW_WIDTH,
      height: 1032
    })
  })

  it('grows inward from the docked edge when it opens', () => {
    // The docked edge does not move: a right-docked panel keeps its right edge
    // against the screen and reaches left, which is the direction the rail's
    // arrow points.
    const closed = panelBounds(AREA, 'right', CLOSED)
    const open = panelBounds(AREA, 'right', OPEN)
    expect(open.x + open.width).toBe(closed.x + closed.width)
    expect(open.x).toBe(1920 - expandedWidth(AREA.height))
  })

  it('grows inward from the left edge too, with the left edge pinned', () => {
    const open = panelBounds(AREA, 'left', OPEN)
    expect(open.x).toBe(0)
    expect(open.width).toBe(expandedWidth(AREA.height))
  })

  /*
   * #153's third correction: the shell docked LEFT did not reach the bottom of
   * the screen while the right edge did. The two edges must be one rectangle
   * mirrored, so every one of these runs BOTH ways round — a regression that
   * only shows on one side is exactly what got shipped.
   */
  it('spans the usable height it was given, at that rectangle’s own origin, on both edges', () => {
    const reserved = { x: 0, y: 48, width: 1920, height: 984 }
    for (const edge of ['left', 'right'] as const) {
      for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
        const bounds = panelBounds(reserved, edge, layout)
        expect(bounds.y).toBe(48)
        expect(bounds.height).toBe(984)
        // Stated as the bottom edge as well as the height, because "reaches the
        // bottom" is the thing the maintainer was looking at.
        expect(bounds.y + bounds.height).toBe(reserved.y + reserved.height)
      }
    }
  })

  it('stays inside the rectangle it was handed, on both edges', () => {
    for (const area of [
      { x: 0, y: 0, width: 1920, height: 1032 },
      { x: 0, y: 48, width: 1920, height: 984 },
      { x: 2560, y: 357, width: 1920, height: 1032 },
      { x: 0, y: 0, width: 480, height: 600 }
    ]) {
      for (const edge of ['left', 'right'] as const) {
        for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
          const bounds = panelBounds(area, edge, layout)
          expect(bounds.x).toBeGreaterThanOrEqual(area.x)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
        }
      }
    }
  })

  /*
   * Windows refuses to make a window narrower than 32px — measured on the
   * maintainer's machine, where a 20px rail came back 32px wide. Asking for 20
   * therefore docks the rail differently on each edge: right-docked the extra
   * twelve hang off the screen and the rail still looks right, left-docked they
   * do not and it comes out fat. The floor is requested here so both edges get
   * the same window, and the renderer draws the design's 20px rail against the
   * docked side of it.
   */
  it('never asks for a window narrower than the platform will make', () => {
    for (const edge of ['left', 'right'] as const) {
      const bounds = panelBounds(AREA, edge, CLOSED)
      expect(bounds.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    }
  })

  it('stays on the display it was handed, negative origins included', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(panelBounds(secondary, 'right', CLOSED).x).toBe(-MIN_WINDOW_WIDTH)
    expect(panelBounds(secondary, 'left', OPEN).x).toBe(-1920)
  })

  it('returns whole pixels, which is all Electron accepts for bounds', () => {
    const odd = { x: 0, y: 0, width: 1367, height: 769 }
    for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
      const bounds = panelBounds(odd, 'right', layout)
      for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true)
    }
  })
})

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen: "is
 * never narrower than the smallest panel the cave still reads in", "carries the
 * chrome MineScene actually wraps around the cave", and "leaves the secondary
 * panel wider than the cave floor as well" — with this file's import of
 * `MIN_PANEL_SIZE` and `PANEL_CHROME`.
 *
 * All three existed because the cave was drawn with `object-fit: cover`, which
 * crops the side walls of a narrow box and could take a whole workstation with
 * them, so the renderer computed the narrowest box that still held every anchor
 * and main had to reserve at least that much column. The interior is drawn with
 * `contain`: nothing is ever cropped at any shape, so there is no computed floor
 * left to reserve against, and the derived constants it produced are gone from
 * sceneSizing (see the removal note there).
 *
 * AMENDED again for #153: the pairing used to be against the fixed
 * `MINE_INTERIOR_WIDTH`/`MINE_COLUMN_WIDTH`, and both are gone — the column is
 * derived from the display's height now, so what has to be held is that main
 * and the renderer derive the SAME width at every height, which is what "the
 * derived columns" above asserts. What is left here is the relationship between
 * the two columns, which the derivation could break at an extreme shape.
 */
describe('the mine column against the panel it opens beside', () => {
  it('leaves the secondary panel room the mine column never eats into', () => {
    // The mine is mounted OUTBOARD of the navigation stack, so opening one
    // widens the window rather than squeezing what is already in it.
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1392, 2160]) {
      expect(expandedWidth(height)).toBeGreaterThan(mineColumnWidth(height))
    }
  })

  it('draws the interior at the painting’s own shape, never fatter than it is tall', () => {
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1392, 2160]) {
      expect(interiorColumnWidth(height)).toBeLessThan(height)
    }
  })
})
