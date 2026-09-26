import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PanelEdge } from '../domain/types'
import type { Platform } from '../platform/platform'
import type { ScreenRect } from '../platform/screenArea'
import { minWindowWidth } from '../platform/windowMetrics'
/*
 * Crosses the main -> renderer boundary only to PIN two copies equal (see
 * AGENTS.md's boundaries section): the interior column main derives below,
 * against the renderer's own `interiorColumnWidth` and `SHELL_CONTENT_INSET`,
 * asserted in "the derived columns" and "the redesigned Panel grid" below.
 * (`DESIGN_INTERIOR_WIDTH` left this import with the 245px case, #635.)
 * Production code never imports across this boundary either way.
 */
import { SHELL_CONTENT_INSET, interiorColumnWidth } from '../../renderer/src/lib/scene/sceneSizing'
import {
  DESIGN_COMPOSITION_HEIGHT,
  DESIGN_SCREEN_HEIGHT,
  DOCK_INSET,
  MESSAGE_PANEL_DESIGN_WIDTH,
  MESSAGE_PANEL_GAP,
  MINE_COLUMN_MIN_WIDTH,
  NAV_WIDTH,
  PAGE_WIDTH,
  RAIL_WIDTH,
  SHELL_EDGE_MARGIN,
  SHELL_GAP,
  SHELL_PADDING,
  clampMessagePanelBounds,
  detachedMessagePanelBounds,
  detachedMessagePanelWidth,
  expandedWidth,
  messagePanelAnchorOf,
  messagePanelBounds,
  messagePanelPlacement,
  messagePanelWidth,
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

/*
 * AMENDED for #465. Every case below that pins the collapsed rail against a
 * platform floor used to import the constant `MIN_WINDOW_WIDTH` and assert it
 * with no platform named — a Windows measurement the arithmetic applied
 * everywhere. The floor is per-platform now, so each of those cases says which
 * platform it is asserting and this file still reads the host's OS zero times.
 */
const WIN32_FLOOR = minWindowWidth('win32')

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
    expect(panelWidth(AREA, CLOSED, 'win32')).toBe(WIN32_FLOOR)
    expect(RAIL_WIDTH).toBeLessThan(WIN32_FLOOR)
  })

  /*
   * ADDED for #465. Those twelve pixels are the Windows measurement, and they
   * were spent on every platform: on a Mac the collapsed window stood wider
   * than the rail the renderer paints into it, and the gutter left over is
   * transparent — which is the rectangle the OS drew its shadow around.
   */
  it.each<Platform>(['darwin', 'linux'])(
    'collapses to exactly the rail on %s, with no transparent gutter beside it (#465)',
    (platform) => {
      expect(panelWidth(AT_1X, CLOSED, platform)).toBe(RAIL_WIDTH)
      expect(panelWidth(AT_1X, CLOSED, platform)).toBeLessThan(panelWidth(AT_1X, CLOSED, 'win32'))
      // And it scales with the display like every other width here, rather
      // than being pinned to the design's literal 20.
      expect(panelWidth(AT_2X, CLOSED, platform)).toBe(RAIL_WIDTH * 2)
    }
  )

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
    // Narrower than the design's own composition: the panel spans the display
    // rather than hanging off the side (decision log, Narrow screen: the dock
    // never grows past the screen).
    // AMENDED for #635 (was: 480 wide): the redesigned grid is narrower than
    // the map-shaped column it replaced, so 480x600 now holds the whole of it;
    // 240 is narrower than the scaled grid again.
    const narrow = { x: 0, y: 0, width: 240, height: 600 }
    expect(panelWidth(narrow, OPEN)).toBe(240)
    expect(panelWidth(narrow, OPEN_WITH_MINE)).toBe(240)
    // The rail is smaller than any display, so it is never clamped.
    expect(panelWidth(narrow, CLOSED, 'win32')).toBe(WIN32_FLOOR)
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
    expect(panelWidth(shortLaptop, CLOSED, 'win32')).toBe(WIN32_FLOOR)
    // And lets it grow past the floor once the scale asks for more.
    expect(panelWidth(AT_2X, CLOSED, 'win32')).toBe(RAIL_WIDTH * 2)
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
  /*
   * REMOVED for #635, stated here rather than passing unseen: "reproduces the
   * design’s own 245px interior at the design’s own 768-tall composition". 245
   * was the retired v4 mock's column; the redesign draws the mine column at
   * the painting's height less its chrome, floored at 300px, which "the
   * redesigned Panel grid" above pins at the design screen and beyond it.
   */

  it('reserves exactly the interior column the renderer draws, plus the gap beside it', () => {
    // AMENDED for #635 (was: `- 8`): the gap is the redesign's 6px.
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1032, 1392, 2160]) {
      expect(mineColumnWidth(height) - SHELL_GAP).toBe(interiorColumnWidth(height))
    }
  })

  it('gives the page one width whatever the display’s height', () => {
    // AMENDED for #635 (was: "never squeezes the secondary column below the
    // design’s own content width", against the 555px floor of a column that
    // followed the map's shape). The page is 440px whatever it shows.
    expect(secondaryColumnWidth(200)).toBe(PAGE_WIDTH)
    expect(secondaryColumnWidth(DESIGN_COMPOSITION_HEIGHT)).toBe(PAGE_WIDTH)
    expect(secondaryColumnWidth(2160)).toBe(PAGE_WIDTH)
  })

  /*
   * REMOVED for #635, stated here rather than passing unseen: the describe
   * block "the map column hugs its painting" (#165) and its three cases —
   * "leaves the painting no margin at the design screen", "leaves it none at
   * any height the fit rule governs" and "counts the same frame the stylesheet
   * draws" — with this file's import of `MAP_FRAME_INSET`. They held a
   * secondary column derived from the map painting's shape inside its frame;
   * the redesign gives the page one 440px width whatever it shows, so there is
   * no derivation left to hold. The map page's own fit is the map-page
   * organism's, rebuilt in its own slice of #635.
   */

  it('spends the opened width on the design’s own chrome plus that column', () => {
    // AMENDED for #635 (was: 90, the v4 frame). The redesigned plate: both
    // edge margins, the padding, the nav, the rail and two gaps.
    for (const height of [DESIGN_COMPOSITION_HEIGHT, 1392]) {
      expect(expandedWidth(height) - secondaryColumnWidth(height)).toBe(104)
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

/*
 * ADDED for #635. The redesigned Panel's grid (screens/shell.md, Layout and
 * Parts): the nav column at the screen edge, the page column beside it, and the
 * mine column between them while a mine is open, on one rock plate with a 6px
 * padding and 6px gaps, held 2px off the screen edge. The closed rail stays
 * exactly as it was (#388) until the Veta slice retires it, so it is still
 * the free-side column of every open composition.
 */
describe('the redesigned Panel grid', () => {
  it('declares the grid’s own columns and spacing', () => {
    expect(NAV_WIDTH).toBe(56)
    expect(PAGE_WIDTH).toBe(440)
    expect(MINE_COLUMN_MIN_WIDTH).toBe(300)
    expect(SHELL_PADDING).toBe(6)
    expect(SHELL_GAP).toBe(6)
    expect(SHELL_EDGE_MARGIN).toBe(2)
    expect(DOCK_INSET).toBe(12)
  })

  it('spends the opened width on the plate, the nav, the page and the rail', () => {
    // 2 + 6 + 56 + 6 + 440 + 6 + 20 + 6 + 2: the edge margin and the plate's
    // own frame edge on the free side, the padding, the nav, the page and the
    // rail with a gap before each of the last two.
    expect(expandedWidth(DESIGN_SCREEN_HEIGHT)).toBe(544)
    expect(expandedWidth(1392)).toBe(544)
  })

  it('draws the mine column at the painting’s height less its chrome, never under 300px', () => {
    // The column is as tall as the shell's content: the work area less the
    // dock's 12px top and bottom and the plate's 6px padding.
    const art = (height: number) => Math.round((height - 36 - 196) * (1184 / 3622))
    expect(mineColumnWidth(DESIGN_SCREEN_HEIGHT)).toBe(300 + SHELL_GAP)
    expect(mineColumnWidth(3000)).toBe(art(3000) + 16 + SHELL_GAP)
    expect(mineColumnWidth(0)).toBe(300 + SHELL_GAP)
  })

  it('adds only the mine column and its gap when a mine opens beside the page', () => {
    expect(panelWidth(AT_1X, OPEN_WITH_MINE) - panelWidth(AT_1X, OPEN)).toBe(306)
  })

  it('keeps the mine column and the nav, without the page, when only the page closes', () => {
    expect(mineOnlyWidth(DESIGN_SCREEN_HEIGHT)).toBe(544 - PAGE_WIDTH - SHELL_GAP + 306)
  })

  it('reserves the same grid the renderer’s stylesheet draws', () => {
    // main cannot read CSS, so its copies are pinned to the stylesheet itself,
    // the way the design tokens were pinned for the map frame before (#165).
    const app = readFileSync(join(import.meta.dirname, '../../renderer/src/App.vue'), 'utf8')
    const px = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(app)?.[1])
    expect(px('shell-pad')).toBe(SHELL_PADDING)
    expect(px('shell-gap')).toBe(SHELL_GAP)
    expect(px('shell-edge')).toBe(SHELL_EDGE_MARGIN)
    expect(px('dock-inset')).toBe(DOCK_INSET)
    expect(px('page-width')).toBe(PAGE_WIDTH)
    // And the renderer's own copy of the height they leave the mine column.
    expect(SHELL_CONTENT_INSET).toBe(2 * DOCK_INSET + 2 * SHELL_PADDING)
  })

  it('composes the same design width on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const layout of [OPEN, OPEN_WITH_MINE, { expanded: false, mineOpen: true }]) {
        expect(panelWidth(AT_1X, layout, platform)).toBe(panelWidth(AT_1X, layout, 'win32'))
      }
    }
  })
})

describe('panelBounds', () => {
  it('hangs the closed rail on the right edge by default', () => {
    expect(panelBounds(AREA, 'right', CLOSED, 'win32')).toEqual({
      x: 1920 - WIN32_FLOOR,
      y: 0,
      width: WIN32_FLOOR,
      height: 1032
    })
  })

  it('hangs the closed rail on the left edge when that is the docked side', () => {
    expect(panelBounds(AREA, 'left', CLOSED, 'win32')).toEqual({
      x: 0,
      y: 0,
      width: WIN32_FLOOR,
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
    // AMENDED for #465: asserted for each platform's own floor rather than for
    // the Windows one everywhere, which is the untruth that issue removes.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const edge of ['left', 'right'] as const) {
        const bounds = panelBounds(AREA, edge, CLOSED, platform)
        expect(bounds.width).toBeGreaterThanOrEqual(minWindowWidth(platform))
      }
    }
  })

  it('stays on the display it was handed, negative origins included', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(panelBounds(secondary, 'right', CLOSED, 'win32').x).toBe(-WIN32_FLOOR)
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
    // Opening a mine widens the window rather than squeezing what is already
    // in it. AMENDED for #635 (was: the whole opened width compared with the
    // mine column's): the page is a fixed 440px now, so a tall display's mine
    // column may be the wider of the two; what opening one must never do is
    // take width from the page, which is what this asserts.
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1392, 2160]) {
      expect(expandedWidth(height) + mineColumnWidth(height)).toBeGreaterThan(expandedWidth(height))
      expect(secondaryColumnWidth(height)).toBe(PAGE_WIDTH)
    }
  })

  it('draws the interior at the painting’s own shape, never fatter than it is tall', () => {
    for (const height of [600, DESIGN_COMPOSITION_HEIGHT, 1392, 2160]) {
      expect(interiorColumnWidth(height)).toBeLessThan(height)
    }
  })
})
/*
 * The message panel is its OWN window beside the shell (#162), so its rectangle
 * is derived here rather than reconciled inside the shell's CSS. #159 shipped
 * the honest single-window compromise — a band docked at the shell's free edge,
 * `min(990, available)` — and flagged this as the follow-up; the design's own
 * `assets/mine/mine-and-message-panel.png` draws the panel as a second surface
 * on the desktop, beside an untouched shell, aligned to its bottom.
 */
describe('messagePanelBounds', () => {
  /** The shell as `panelBounds` places it, so the two derivations are used together. */
  function shellAt(area: ScreenRect, edge: PanelEdge, layout = OPEN_WITH_MINE): ScreenRect {
    return panelBounds(area, edge, layout)
  }

  /** The panel's own opening height, in design pixels (see lib/message/panelHeight). */
  const DESIGN_HEIGHT = 235

  /** The composition the design's own mock draws the panel beside. */
  const MINE_ONLY = { expanded: false, mineOpen: true }

  it('takes the design’s own 990px, scaled onto this display, when the room is there', () => {
    // The mine-only composition is what the design's mock draws beside it, and
    // it leaves well over 990 design pixels on a 1080-tall display.
    for (const area of [AT_1X, AT_2X]) {
      const shell = shellAt(area, 'right', MINE_ONLY)
      const bounds = messagePanelBounds(area, shell, 'right', DESIGN_HEIGHT)
      expect(bounds.width).toBe(scaled(area, MESSAGE_PANEL_DESIGN_WIDTH))
    }
  })

  it('sits at the shell’s FREE edge, one gap away, on both docked sides', () => {
    const gap = scaled(AT_1X, MESSAGE_PANEL_GAP)

    const rightShell = shellAt(AT_1X, 'right', MINE_ONLY)
    const beside = messagePanelBounds(AT_1X, rightShell, 'right', DESIGN_HEIGHT)
    // A right-docked shell puts the panel to its left, and the two never touch.
    expect(beside.x + beside.width).toBe(rightShell.x - gap)

    const leftShell = shellAt(AT_1X, 'left', MINE_ONLY)
    const mirrored = messagePanelBounds(AT_1X, leftShell, 'left', DESIGN_HEIGHT)
    expect(mirrored.x).toBe(leftShell.x + leftShell.width + gap)
  })

  it('aligns its bottom with the shell’s, which is what the mock draws', () => {
    for (const edge of ['left', 'right'] as const) {
      const shell = shellAt(AT_1X, edge)
      const bounds = messagePanelBounds(AT_1X, shell, edge, DESIGN_HEIGHT)
      expect(bounds.y + bounds.height).toBe(shell.y + shell.height)
    }
  })

  it('spends the design’s height through the SAME scale the shell is zoomed by', () => {
    // The 1080-design-world zoom applies to this window identically: the
    // renderer draws the design's own 235px and main multiplies once.
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      const shell = shellAt(area, 'right')
      const bounds = messagePanelBounds(area, shell, 'right', DESIGN_HEIGHT)
      expect(bounds.height).toBe(Math.round(DESIGN_HEIGHT * uiScale(area)))
    }
  })

  it('carries a dragged height through unchanged, because the resize is vertical only', () => {
    const shell = shellAt(AT_1X, 'right', MINE_ONLY)
    const short = messagePanelBounds(AT_1X, shell, 'right', 235)
    const tall = messagePanelBounds(AT_1X, shell, 'right', 578)
    expect(tall.height).toBeGreaterThan(short.height)
    // Only the height moves: the panel is resizable vertically ONLY.
    expect(tall.width).toBe(short.width)
    expect(tall.x).toBe(short.x)
    // And it grows UPWARD, because the bottom edge is the one that is aligned.
    expect(tall.y).toBeLessThan(short.y)
  })

  /*
   * The multi-display honesty the issue asks for, decided and pinned here.
   *
   * Of the three candidates — shrink to the room available, flip to the shell's
   * other side, or fall back to #159's docked band — this takes the FIRST, and
   * the other two are refused on purpose:
   *
   * Flipping moves the panel across the desktop as the shell grows, and "the
   * other side" of a shell docked against a screen edge is off the display; the
   * panel would also leave the mine it belongs to.
   *
   * Re-docking inside the shell is what this issue removes, and it would need
   * the shell to grow for the panel — the missing third dimension of
   * PanelLayoutRequest that dies with this.
   *
   * Shrinking is already this file's answer to a composition a display cannot
   * hold (see panelWidth's clamp and secondaryColumnWidth's floor) and is what
   * #159's band already shipped, so it is the narrowing the user has already
   * seen rather than a new behaviour.
   */
  describe('when the display has no 990px of room beside the shell', () => {
    it('shrinks to the room it has rather than hanging off the display', () => {
      // AMENDED for #635 (was: the 1920-wide AT_1X): the redesigned shell is
      // narrow enough to leave 990 free there, so a 1600-wide display is the
      // one whose widest composition leaves less than 990.
      const area = { x: 0, y: 0, width: 1600, height: DESIGN_SCREEN_HEIGHT }
      const shell = shellAt(area, 'right', OPEN_WITH_MINE)
      const bounds = messagePanelBounds(area, shell, 'right', DESIGN_HEIGHT)
      // The widest composition — a page and a mine — leaves less than 990.
      expect(bounds.width).toBeLessThan(scaled(area, MESSAGE_PANEL_DESIGN_WIDTH))
      expect(bounds.width).toBe(shell.x - area.x - scaled(area, MESSAGE_PANEL_GAP))
      expect(bounds.x).toBe(area.x)
    })

    it('never flips to the shell’s other side, and never covers it', () => {
      for (const layout of [OPEN, OPEN_WITH_MINE, MINE_ONLY]) {
        const rightShell = shellAt(AT_1X, 'right', layout)
        const beside = messagePanelBounds(AT_1X, rightShell, 'right', DESIGN_HEIGHT)
        expect(beside.x + beside.width).toBeLessThanOrEqual(rightShell.x)

        const leftShell = shellAt(AT_1X, 'left', layout)
        const mirrored = messagePanelBounds(AT_1X, leftShell, 'left', DESIGN_HEIGHT)
        expect(mirrored.x).toBeGreaterThanOrEqual(leftShell.x + leftShell.width)
      }
    })

    it('still asks for a window the platform will actually make', () => {
      // A display the whole shell spans leaves nothing beside it. A window of
      // no width is not a narrow panel, it is a panel that looks as if it never
      // opened, so `minWindowWidth` applies here too — the one case where the
      // panel may overlap the shell, by at most that platform's own floor.
      const cramped = { x: 0, y: 0, width: 320, height: 768 }
      for (const edge of ['left', 'right'] as const) {
        const shell = shellAt(cramped, edge, OPEN_WITH_MINE)
        expect(shell.width).toBe(cramped.width)
        const bounds = messagePanelBounds(cramped, shell, edge, DESIGN_HEIGHT, 'win32')
        expect(bounds.width).toBe(WIN32_FLOOR)
      }
    })
  })

  it('stays inside the rectangle it was handed, on both edges and every composition', () => {
    for (const area of [
      AT_1X,
      AT_1_333X,
      AT_2X,
      { x: 0, y: 48, width: 1920, height: 984 },
      { x: 2560, y: 357, width: 1920, height: 1032 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1024, height: 768 }
    ]) {
      for (const edge of ['left', 'right'] as const) {
        for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
          const shell = shellAt(area, edge, layout)
          for (const height of [235, 578]) {
            const bounds = messagePanelBounds(area, shell, edge, height)
            expect(bounds.x).toBeGreaterThanOrEqual(area.x)
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
            expect(bounds.y).toBeGreaterThanOrEqual(area.y)
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height)
          }
        }
      }
    }
  })

  it('never asks for more height than the display has', () => {
    // The design's own ceiling always fits, because the whole surface is scaled
    // onto the display: 578 design pixels on a 200-tall screen is 107 real
    // ones. This is the guard for a height that is not the design's — main
    // takes the number the renderer measured, and a window taller than the
    // display would put the panel's own controls off the top of it.
    const shortest = { x: 0, y: 0, width: 1920, height: 200 }
    const shell = shellAt(shortest, 'right')
    expect(messagePanelBounds(shortest, shell, 'right', 578).height).toBe(
      Math.round(578 * uiScale(shortest))
    )
    const absurd = messagePanelBounds(shortest, shell, 'right', 99_999)
    expect(absurd.height).toBe(200)
    expect(absurd.y).toBe(0)
  })

  it('returns whole pixels, which is all Electron accepts for bounds', () => {
    const odd = { x: 0, y: 0, width: 1367, height: 769 }
    const shell = shellAt(odd, 'right')
    const bounds = messagePanelBounds(odd, shell, 'right', 237)
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true)
  })
})

/*
 * The panel the person MOVED (#296).
 *
 * Everything above derives the panel's rectangle from where the shell is. This
 * block is the other half: once the person has dragged the window somewhere,
 * the shell stops being the thing it is placed against, and the only rectangle
 * that still matters is the one they chose — kept on the screen, and nothing
 * else. The arithmetic is here for the reason the docked arithmetic is: a clamp
 * that only ever runs on a real display is a clamp nobody can assert.
 */
describe('detachedMessagePanelWidth', () => {
  it('takes the design’s own 990px, scaled onto this display', () => {
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      expect(detachedMessagePanelWidth(area)).toBe(scaled(area, MESSAGE_PANEL_DESIGN_WIDTH))
    }
  })

  it('never asks for more width than the display has', () => {
    expect(detachedMessagePanelWidth({ x: 0, y: 0, width: 640, height: 1080 })).toBe(640)
  })

  it('still asks for a window the platform will actually make', () => {
    // The same floor the docked panel holds: a window of no width is not a
    // narrow panel, it is one that looks as though it never opened.
    expect(detachedMessagePanelWidth({ x: 0, y: 0, width: 1920, height: 20 }, 'win32')).toBe(
      WIN32_FLOOR
    )
  })

  it('owes nothing to the shell, which is the whole point of being detached', () => {
    // The docked width shrinks to the room beside the shell (see
    // messagePanelWidth); a detached panel is not placed beside anything, so a
    // shell spanning the display cannot narrow it.
    const spanning = { x: 0, y: 0, width: AT_1X.width, height: AT_1X.height }
    expect(detachedMessagePanelWidth(AT_1X)).toBeGreaterThan(
      messagePanelWidth(AT_1X, spanning, 'right')
    )
  })
})

describe('clampMessagePanelBounds', () => {
  const RECT = { x: 400, y: 300, width: 990, height: 235 }

  it('leaves a rectangle already inside the work area exactly where it is', () => {
    expect(clampMessagePanelBounds(AT_1X, RECT)).toEqual(RECT)
  })

  it('pulls a rectangle hanging off the right or the bottom back inside', () => {
    const off = clampMessagePanelBounds(AT_1X, { ...RECT, x: 1800, y: 1000 })
    expect(off.x).toBe(AT_1X.width - RECT.width)
    expect(off.y).toBe(AT_1X.height - RECT.height)
  })

  it('pulls a rectangle hanging off the left or the top back inside', () => {
    const off = clampMessagePanelBounds(AT_1X, { ...RECT, x: -500, y: -80 })
    expect(off.x).toBe(0)
    expect(off.y).toBe(0)
  })

  it('clamps against the rectangle it was handed, never against the origin', () => {
    // A second display sits at its own origin, and that origin can be negative.
    for (const area of [
      { x: 2560, y: 357, width: 1920, height: 1032 },
      { x: -1920, y: 0, width: 1920, height: 1080 }
    ]) {
      const pushed = clampMessagePanelBounds(area, { ...RECT, x: area.x - 4000, y: area.y - 4000 })
      expect(pushed.x).toBe(area.x)
      expect(pushed.y).toBe(area.y)
      const pulled = clampMessagePanelBounds(area, { ...RECT, x: area.x + 9999, y: area.y + 9999 })
      expect(pulled.x + pulled.width).toBe(area.x + area.width)
      expect(pulled.y + pulled.height).toBe(area.y + area.height)
    }
  })

  it('never asks for a window bigger than the work area', () => {
    const huge = clampMessagePanelBounds(
      { x: 0, y: 0, width: 800, height: 200 },
      { x: 0, y: 0, width: 990, height: 578 }
    )
    expect(huge.width).toBe(800)
    expect(huge.height).toBe(200)
  })

  it('returns whole pixels, which is all Electron accepts for bounds', () => {
    const odd = clampMessagePanelBounds(
      { x: 0, y: 0, width: 1367, height: 769 },
      { x: 12.4, y: 700.6, width: 990.5, height: 235.5 }
    )
    for (const value of Object.values(odd)) expect(Number.isInteger(value)).toBe(true)
  })
})

describe('detachedMessagePanelBounds', () => {
  const DESIGN_HEIGHT = 235
  const ANCHOR = { x: 300, bottom: 900 }

  it('puts the panel back exactly where the person left it', () => {
    const bounds = detachedMessagePanelBounds(AT_1X, ANCHOR, DESIGN_HEIGHT)
    expect(bounds).not.toBeNull()
    expect(bounds?.x).toBe(ANCHOR.x)
    expect(bounds?.y).toBe(ANCHOR.bottom - DESIGN_HEIGHT)
    expect(bounds?.width).toBe(scaled(AT_1X, MESSAGE_PANEL_DESIGN_WIDTH))
    expect(bounds?.height).toBe(Math.round(DESIGN_HEIGHT * uiScale(AT_1X)))
  })

  it('grows UPWARD from the anchored bottom edge, exactly as the docked panel does', () => {
    const short = detachedMessagePanelBounds(AT_1X, ANCHOR, 235)
    const tall = detachedMessagePanelBounds(AT_1X, ANCHOR, 578)
    expect((short?.y ?? 0) + (short?.height ?? 0)).toBe(ANCHOR.bottom)
    expect((tall?.y ?? 0) + (tall?.height ?? 0)).toBe(ANCHOR.bottom)
    expect(tall?.y).toBeLessThan(short?.y ?? 0)
    expect(tall?.x).toBe(short?.x)
  })

  it('keeps a panel dragged half off the screen on the screen', () => {
    const bounds = detachedMessagePanelBounds(AT_1X, { x: 1600, bottom: 1200 }, DESIGN_HEIGHT)
    expect(bounds?.x).toBe(AT_1X.width - scaled(AT_1X, MESSAGE_PANEL_DESIGN_WIDTH))
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBe(AT_1X.height)
  })

  it('refuses an anchor that no longer touches this display at all', () => {
    // The monitor it was dragged onto was unplugged, or the resolution shrank
    // under it: a rectangle with nothing on screen is not a position to honour,
    // and clamping it would move the panel somewhere nobody chose.
    expect(detachedMessagePanelBounds(AT_1X, { x: 3000, bottom: 900 }, DESIGN_HEIGHT)).toBeNull()
    expect(detachedMessagePanelBounds(AT_1X, { x: -1500, bottom: 900 }, DESIGN_HEIGHT)).toBeNull()
    expect(detachedMessagePanelBounds(AT_1X, { x: 300, bottom: -10 }, DESIGN_HEIGHT)).toBeNull()
    expect(detachedMessagePanelBounds(AT_1X, { x: 300, bottom: 2000 }, DESIGN_HEIGHT)).toBeNull()
  })

  it('refuses a work area with no room in it', () => {
    expect(detachedMessagePanelBounds({ x: 0, y: 0, width: 0, height: 0 }, ANCHOR, 235)).toBeNull()
  })

  it('reads back the anchor of the rectangle it produced', () => {
    const bounds = detachedMessagePanelBounds(AT_1X, ANCHOR, DESIGN_HEIGHT)
    expect(messagePanelAnchorOf(bounds as ScreenRect)).toEqual(ANCHOR)
  })
})

describe('messagePanelPlacement', () => {
  const DESIGN_HEIGHT = 235
  const MINE_ONLY = { expanded: false, mineOpen: true }

  it('is the docked rectangle while nothing has been moved', () => {
    for (const edge of ['left', 'right'] as const) {
      for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
        const shell = panelBounds(AT_1X, edge, layout)
        expect(messagePanelPlacement(AT_1X, shell, edge, DESIGN_HEIGHT, null)).toEqual(
          messagePanelBounds(AT_1X, shell, edge, DESIGN_HEIGHT)
        )
      }
    }
  })

  it('stops following the shell once the person has moved it', () => {
    // The decision the whole issue is about: a shell that moved, grew or
    // changed its docked side no longer drags the panel around with it.
    const anchor = { x: 300, bottom: 900 }
    const railRight = panelBounds(AT_1X, 'right', CLOSED)
    const openLeft = panelBounds(AT_1X, 'left', OPEN_WITH_MINE)
    expect(messagePanelPlacement(AT_1X, railRight, 'right', DESIGN_HEIGHT, anchor)).toEqual(
      messagePanelPlacement(AT_1X, openLeft, 'left', DESIGN_HEIGHT, anchor)
    )
  })

  it('lets the person put the panel ON TOP of the shell', () => {
    // It is already a child window, so it stands above the shell; nothing here
    // may refuse an overlap somebody chose.
    // AMENDED for #635 (was: anchored at the shell's own left edge): the
    // redesigned shell is narrow enough that a 990 panel anchored there would
    // run off the display and be clamped back, so it is anchored 200px short of
    // the shell and still overlaps it.
    const shell = panelBounds(AT_1X, 'right', OPEN_WITH_MINE)
    const onTop = messagePanelPlacement(AT_1X, shell, 'right', DESIGN_HEIGHT, {
      x: shell.x - 200,
      bottom: shell.y + shell.height
    })
    expect(onTop.x).toBe(shell.x - 200)
    expect(onTop.x + onTop.width).toBeGreaterThan(shell.x)
  })

  it('keeps resizing in place when the panel reports a new height', () => {
    const anchor = { x: 300, bottom: 900 }
    const shell = panelBounds(AT_1X, 'right', MINE_ONLY)
    const short = messagePanelPlacement(AT_1X, shell, 'right', 235, anchor)
    const tall = messagePanelPlacement(AT_1X, shell, 'right', 578, anchor)
    expect(tall.height).toBeGreaterThan(short.height)
    expect(tall.x).toBe(short.x)
    expect(tall.y + tall.height).toBe(short.y + short.height)
  })

  it('falls back to the docked rectangle when the position no longer fits', () => {
    const shell = panelBounds(AT_1X, 'right', MINE_ONLY)
    const anchor = { x: 4000, bottom: 900 }
    expect(messagePanelPlacement(AT_1X, shell, 'right', DESIGN_HEIGHT, anchor)).toEqual(
      messagePanelBounds(AT_1X, shell, 'right', DESIGN_HEIGHT)
    )
  })

  it('stays inside the work area for every anchor, on both edges', () => {
    for (const area of [
      AT_1X,
      AT_2X,
      { x: 2560, y: 357, width: 1920, height: 1032 },
      { x: 0, y: 0, width: 1024, height: 768 }
    ]) {
      for (const edge of ['left', 'right'] as const) {
        for (const anchor of [
          { x: area.x + 10, bottom: area.y + 400 },
          { x: area.x + area.width - 20, bottom: area.y + area.height + 300 },
          { x: area.x - 20, bottom: area.y + 40 }
        ]) {
          const shell = panelBounds(area, edge, OPEN_WITH_MINE)
          const bounds = messagePanelPlacement(area, shell, edge, 578, anchor)
          expect(bounds.x).toBeGreaterThanOrEqual(area.x)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
          expect(bounds.y).toBeGreaterThanOrEqual(area.y)
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height)
        }
      }
    }
  })
})
