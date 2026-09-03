import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ScreenRect } from '../platform/screenArea'
import {
  DESIGN_INTERIOR_WIDTH,
  SHELL_CONTENT_INSET,
  interiorColumnWidth
} from '../../renderer/src/lib/scene/sceneSizing'
import {
  DESIGN_COMPOSITION_HEIGHT,
  DESIGN_SCREEN_HEIGHT,
  DESIGN_SECONDARY_WIDTH,
  MAP_FRAME_INSET,
  MIN_WINDOW_WIDTH,
  RAIL_WIDTH,
  expandedWidth,
  mineColumnWidth,
  mineOnlyWidth,
  panelBounds,
  panelWidth,
  secondaryColumnWidth,
  uiScale
} from './panelBounds'

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }

/** The three displays the acceptance ruling names, by the scale each produces. */
const AT_1X = { x: 0, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT }
const AT_1_333X = { x: 0, y: 0, width: 2560, height: 1440 }
const AT_2X = { x: 0, y: 0, width: 3840, height: 2160 }

/** The physical width a design-world figure occupies on this display. */
function scaled(area: ScreenRect, designWidth: number): number {
  return Math.round(designWidth * uiScale(area))
}

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
  /*
   * AMENDED for #153's fifth correction. This case used to read "whether or not
   * a mine is held open", asserting that `{ expanded: false, mineOpen: true }`
   * was still just the rail — because `expanded` then meant "the shell is open
   * at all" and a mine could only ever be held BESIDE an open secondary panel.
   * The maintainer's ruling separates the two controls: the rail's arrow closes
   * the SECONDARY panel and leaves the mine standing, so that combination is now
   * a state the window really has, and it has a width of its own (below).
   */
  it('is the closed rail only when nothing at all is drawn', () => {
    // The design's rail is 20px and the renderer still draws exactly that; the
    // WINDOW is the platform's 32px floor, because Windows will not make one
    // narrower and asking for 20 docks differently on each edge (see below).
    expect(panelWidth(AREA, CLOSED)).toBe(MIN_WINDOW_WIDTH)
    expect(RAIL_WIDTH).toBeLessThan(MIN_WINDOW_WIDTH)
  })

  it('holds the mine column open with the secondary panel closed beside it', () => {
    const mineOnly = { expanded: false, mineOpen: true }
    expect(panelWidth(AREA, mineOnly)).toBe(scaled(AREA, mineOnlyWidth(DESIGN_SCREEN_HEIGHT)))
    // Wider than the rail, narrower than the panel that carries a secondary.
    expect(panelWidth(AREA, mineOnly)).toBeGreaterThan(panelWidth(AREA, CLOSED))
    expect(panelWidth(AREA, mineOnly)).toBeLessThan(panelWidth(AREA, OPEN_WITH_MINE))
  })

  it('opens to the design world’s own width, scaled onto this display', () => {
    expect(panelWidth(AREA, OPEN)).toBe(scaled(AREA, expandedWidth(DESIGN_SCREEN_HEIGHT)))
  })

  it('adds the mine column when a mine is held open beside the secondary panel', () => {
    expect(panelWidth(AREA, OPEN_WITH_MINE)).toBe(
      scaled(AREA, expandedWidth(DESIGN_SCREEN_HEIGHT) + mineColumnWidth(DESIGN_SCREEN_HEIGHT))
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

  it('grows with the display, because the whole surface is scaled onto it', () => {
    const short = { x: 0, y: 0, width: 3840, height: 768 }
    const tall = { x: 0, y: 0, width: 3840, height: 1392 }
    expect(panelWidth(tall, OPEN)).toBeGreaterThan(panelWidth(short, OPEN))
    expect(panelWidth(tall, OPEN_WITH_MINE)).toBeGreaterThan(panelWidth(short, OPEN_WITH_MINE))
  })
})

/*
 * #153's sixth correction: type was far too small on a 2K display. The ruling
 * is that the shell is a surface DESIGNED at 1080 logical pixels tall and then
 * scaled onto whatever display it lands on — one continuous factor, applied to
 * this window and nothing else on the machine, which is exactly what Electron's
 * per-window zoomFactor is. Every number the design states stays literal in the
 * renderer's CSS; only main multiplies.
 */
describe('uiScale', () => {
  it('is the display’s usable height against the design’s own 1080-tall screen', () => {
    expect(uiScale(AT_1X)).toBe(1)
    expect(uiScale(AT_1_333X)).toBeCloseTo(1440 / 1080, 12)
    expect(uiScale(AT_2X)).toBe(2)
  })

  it('is continuous rather than quantised, so 1440p is sized right rather than crisp', () => {
    // The maintainer took this trade deliberately: 1.333 is not a whole number
    // of device pixels per design pixel, and a correctly sized panel beats a
    // pixel-crisp one that reads half the size it should.
    expect(uiScale(AT_1_333X)).not.toBe(1)
    expect(uiScale(AT_1_333X)).not.toBe(2)
  })

  it('scales a display SHORTER than the design world down by the same rule', () => {
    const shortLaptop = { x: 0, y: 0, width: 1366, height: 768 }
    expect(uiScale(shortLaptop)).toBeCloseTo(768 / 1080, 12)
    expect(panelWidth(shortLaptop, OPEN)).toBeLessThan(expandedWidth(DESIGN_SCREEN_HEIGHT))
  })

  it('never divides by a display of no height', () => {
    expect(uiScale({ x: 0, y: 0, width: 1920, height: 0 })).toBe(1)
  })
})

describe('the scaled window', () => {
  it('spends the same design-world width at every scale', () => {
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      for (const layout of [OPEN, OPEN_WITH_MINE]) {
        const design =
          expandedWidth(DESIGN_SCREEN_HEIGHT) +
          (layout.mineOpen ? mineColumnWidth(DESIGN_SCREEN_HEIGHT) : 0)
        expect(panelWidth(area, layout)).toBe(Math.round(design * uiScale(area)))
      }
    }
  })

  it('leaves the CSS-side constants alone: the design world never sees the scale', () => {
    // The renderer keeps drawing 20px rails and 10px type; zoomFactor is what
    // makes them bigger. So every design-world derivation has to be a function
    // of the design screen alone, identical however tall the real display is.
    const first = {
      expanded: expandedWidth(DESIGN_SCREEN_HEIGHT),
      mine: mineColumnWidth(DESIGN_SCREEN_HEIGHT),
      secondary: secondaryColumnWidth(DESIGN_SCREEN_HEIGHT)
    }
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      // Recomputed after "moving" to that display: nothing about the design
      // world may depend on where the window happens to be.
      void area
      expect({
        expanded: expandedWidth(DESIGN_SCREEN_HEIGHT),
        mine: mineColumnWidth(DESIGN_SCREEN_HEIGHT),
        secondary: secondaryColumnWidth(DESIGN_SCREEN_HEIGHT)
      }).toEqual(first)
    }
  })

  it('still spans the display’s usable height exactly, at every scale and both edges', () => {
    // The taskbar clearance is the rectangle screenArea hands over and is
    // already physical, so scaling must not touch it — this is what would
    // break if the vertical arithmetic ever went through the design world.
    const reserved = { x: 0, y: 0, width: 2560, height: 1392 }
    for (const area of [AT_1X, AT_1_333X, AT_2X, reserved]) {
      for (const edge of ['left', 'right'] as const) {
        const bounds = panelBounds(area, edge, OPEN_WITH_MINE)
        expect(bounds.y).toBe(area.y)
        expect(bounds.height).toBe(area.height)
        expect(bounds.x).toBeGreaterThanOrEqual(area.x)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
      }
    }
  })

  it('keeps the closed rail at the platform floor however small the scale makes it', () => {
    const shortLaptop = { x: 0, y: 0, width: 1366, height: 768 }
    expect(panelWidth(shortLaptop, CLOSED)).toBe(MIN_WINDOW_WIDTH)
    // And lets it grow past the floor once the scale asks for more.
    expect(panelWidth(AT_2X, CLOSED)).toBe(RAIL_WIDTH * 2)
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

  /**
   * The third acceptance run's first correction (#165): the map painting sat
   * with margins inside its column.
   *
   * The column followed the map's aspect against the WHOLE content height, but
   * the painting never sees the whole of it — the design's map container spends
   * 21px of padding and a 2px border on every side first. So the box the
   * painting was actually drawn into was 46px shorter and 46px narrower than
   * the one the width was derived for, its shape no longer matched the art, and
   * `contain` letterboxed the difference. Measured in design pixels below,
   * because the margin is a number and not an impression.
   */
  describe('the map column hugs its painting', () => {
    /** The delivered map art, as `MAP_ART_SIZE` in renderer/src/lib/art.ts. */
    const MAP_ART = { width: 1856, height: 2304 }

    /** The box the painting is drawn into, inside the map container's own frame. */
    function mapBox(windowHeight: number): { width: number; height: number } {
      return {
        width: secondaryColumnWidth(windowHeight) - MAP_FRAME_INSET,
        height: windowHeight - SHELL_CONTENT_INSET - MAP_FRAME_INSET
      }
    }

    /** What `object-fit: contain` leaves empty in that box, per axis, in design px. */
    function letterbox(windowHeight: number): { x: number; y: number } {
      const box = mapBox(windowHeight)
      const scale = Math.min(box.width / MAP_ART.width, box.height / MAP_ART.height)
      return {
        x: box.width - MAP_ART.width * scale,
        y: box.height - MAP_ART.height * scale
      }
    }

    it('leaves the painting no margin at the design screen', () => {
      // Was 11.3 design px of empty column above and below the map, on a box
      // 1018 tall — the margin the acceptance run photographed. Sub-pixel is
      // the whole of what integer column widths can leave behind.
      const empty = letterbox(DESIGN_SCREEN_HEIGHT)
      expect(empty.x).toBeLessThan(1)
      expect(empty.y).toBeLessThan(1)
    })

    it('leaves it none at any height the fit rule governs', () => {
      for (const height of [DESIGN_COMPOSITION_HEIGHT, 1032, 1392, 2160]) {
        const empty = letterbox(height)
        expect(empty.x).toBeLessThan(1)
        expect(empty.y).toBeLessThan(1)
      }
    })

    it('counts the same frame the stylesheet draws', () => {
      // The inset is a copy of CSS main cannot read, so it is pinned to the
      // tokens themselves: `.panel-frame.is-map` spends --space-map-pad on
      // every side inside a --border-highlight border.
      const css = readFileSync(
        join(import.meta.dirname, '../../renderer/src/assets/design-tokens.css'),
        'utf8'
      )
      const pad = Number(/--space-map-pad:\s*(\d+)px/.exec(css)?.[1])
      const border = Number(/--border-highlight:\s*(\d+)px/.exec(css)?.[1])
      expect(MAP_FRAME_INSET).toBe(2 * (pad + border))
    })
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
    expect(open.x).toBe(1920 - panelWidth(AREA, OPEN))
  })

  it('grows inward from the left edge too, with the left edge pinned', () => {
    const open = panelBounds(AREA, 'left', OPEN)
    expect(open.x).toBe(0)
    expect(open.width).toBe(panelWidth(AREA, OPEN))
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
