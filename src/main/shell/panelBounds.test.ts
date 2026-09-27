import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  DOCK_FREE_ROOM,
  DOCK_GAP,
  DOCK_INSET,
  DOCK_WIDTH,
  MINE_COLUMN_MIN_WIDTH,
  NAV_WIDTH,
  PAGE_WIDTH,
  SHELL_EDGE_MARGIN,
  SHELL_GAP,
  SHELL_PADDING,
  dockSlotWidth,
  layoutThatFits,
  mineColumnWidth,
  panelBaseWidth,
  panelBounds,
  panelWidth,
  secondaryColumnWidth,
  uiScale
} from './panelBounds'

/*
 * AMENDED for #635 (PO ruling 2026-09-27: absence in the design is removal), once here rather
 * than at each use. The closed 20px rail is gone, and with it `RAIL_WIDTH`, `mineOnlyWidth` and
 * the `CLOSED` layout: closing the Panel hides its window, as the app mark always did, so there
 * is no composition narrower than the nav and the page. `expandedWidth` is `panelBaseWidth`,
 * because there is no longer a collapsed width for it to be the opposite of. `expanded` left the
 * layout for the same reason; `dockOpen` took its place, the window slot beside the shell.
 */

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }

/** The three displays the acceptance ruling names, by the scale each produces. */
const AT_1X = { x: 0, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT }
const AT_1_333X = { x: 0, y: 0, width: 2560, height: 1440 }
const AT_2X = { x: 0, y: 0, width: 3840, height: 2160 }

/** The physical width a design-world figure occupies on this display. */
function scaled(area: ScreenRect, designWidth: number): number {
  return Math.round(designWidth * uiScale(area))
}

const OPEN = { mineOpen: false, dockOpen: false }
const OPEN_WITH_MINE = { mineOpen: true, dockOpen: false }
const OPEN_WITH_DOCK = { mineOpen: false, dockOpen: true }
const OPEN_WITH_BOTH = { mineOpen: true, dockOpen: true }

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
   * REMOVED for #635 (the PO's ruling of 2026-09-27 removed the rail), stated here rather than
   * passing unseen, with where each guarantee went:
   * - "is the closed rail only when nothing at all is drawn" and "collapses to exactly the rail
   *   on %s, with no transparent gutter beside it (#465)": there is no collapsed window left.
   *   The Panel's close hides the window, and the narrowest window now drawn is the nav and the
   *   page, asserted below. The per-platform floor itself is `windowMetrics.test.ts`'s, and
   *   "never asks for a window narrower than the platform will make" in `panelBounds` below.
   * - "holds the mine column open with the secondary panel closed beside it": the page never
   *   closes in the design ("the page and the nav are always there", screens/shell.md), so the
   *   mine-only composition went with the rail's arrow that produced it.
   */
  it('is the nav, the page and the plate around them while nothing else is open', () => {
    expect(panelWidth(AT_1X, OPEN)).toBe(
      2 * SHELL_EDGE_MARGIN + 2 * SHELL_PADDING + NAV_WIDTH + SHELL_GAP + PAGE_WIDTH
    )
  })

  it('opens to the design world’s own width, scaled onto this display', () => {
    expect(panelWidth(AREA, OPEN)).toBe(scaled(AREA, panelBaseWidth(DESIGN_SCREEN_HEIGHT)))
  })

  it('adds the mine column when a mine is held open beside the secondary panel', () => {
    expect(panelWidth(AREA, OPEN_WITH_MINE)).toBe(
      scaled(AREA, panelBaseWidth(DESIGN_SCREEN_HEIGHT) + mineColumnWidth(DESIGN_SCREEN_HEIGHT))
    )
  })

  /*
   * ADDED for #635 (PO ruling 2026-09-27: no empty region). The window is exactly as wide as
   * what it shows — nav, page, the mine column while a mine is open, and the dock's window slot
   * while something is docked in it — and nothing is reserved for a slot that holds nothing.
   */
  it('adds the dock slot beside the shell only while something is docked in it', () => {
    expect(panelWidth(AREA, OPEN_WITH_DOCK)).toBe(
      scaled(AREA, panelBaseWidth(DESIGN_SCREEN_HEIGHT) + dockSlotWidth())
    )
    expect(panelWidth(AREA, OPEN_WITH_BOTH)).toBe(
      scaled(
        AREA,
        panelBaseWidth(DESIGN_SCREEN_HEIGHT) +
          mineColumnWidth(DESIGN_SCREEN_HEIGHT) +
          dockSlotWidth()
      )
    )
  })

  it('reserves nothing beside the shell while the dock slot is empty', () => {
    // The mine column is the only thing between the two: no rail, no dock room.
    expect(panelWidth(AT_1X, OPEN_WITH_MINE) - panelWidth(AT_1X, OPEN)).toBe(
      mineColumnWidth(DESIGN_SCREEN_HEIGHT)
    )
    expect(panelWidth(AT_1X, OPEN)).toBe(panelBaseWidth(DESIGN_SCREEN_HEIGHT))
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
    // AMENDED for #635: the closed rail's own line went with the rail. The dock never runs past
    // the screen either, with a window docked beside the shell.
    expect(panelWidth(narrow, OPEN_WITH_BOTH)).toBe(240)
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
    expect(panelWidth(shortLaptop, OPEN)).toBeLessThan(panelBaseWidth(DESIGN_SCREEN_HEIGHT))
  })

  it('never divides by a display of no height', () => {
    expect(uiScale({ x: 0, y: 0, width: 1920, height: 0 })).toBe(1)
  })
})

describe('the scaled window', () => {
  it('spends the same design-world width at every scale', () => {
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      // AMENDED for #635: every composition, the docked slot's two included.
      for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
        const design =
          panelBaseWidth(DESIGN_SCREEN_HEIGHT) +
          (layout.mineOpen ? mineColumnWidth(DESIGN_SCREEN_HEIGHT) : 0) +
          (layout.dockOpen ? dockSlotWidth() : 0)
        expect(panelWidth(area, layout)).toBe(Math.round(design * uiScale(area)))
      }
    }
  })

  it('leaves the CSS-side constants alone: the design world never sees the scale', () => {
    // The renderer keeps drawing 20px rails and 10px type; zoomFactor is what
    // makes them bigger. So every design-world derivation has to be a function
    // of the design screen alone, identical however tall the real display is.
    const first = {
      expanded: panelBaseWidth(DESIGN_SCREEN_HEIGHT),
      mine: mineColumnWidth(DESIGN_SCREEN_HEIGHT),
      secondary: secondaryColumnWidth(DESIGN_SCREEN_HEIGHT)
    }
    for (const area of [AT_1X, AT_1_333X, AT_2X]) {
      // Recomputed after "moving" to that display: nothing about the design
      // world may depend on where the window happens to be.
      void area
      expect({
        expanded: panelBaseWidth(DESIGN_SCREEN_HEIGHT),
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
        const bounds = panelBounds(area, edge, OPEN_WITH_BOTH)
        expect(bounds.y).toBe(area.y)
        expect(bounds.height).toBe(area.height)
        expect(bounds.x).toBeGreaterThanOrEqual(area.x)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
      }
    }
  })

  /*
   * REMOVED for #635, stated here rather than passing unseen: "keeps the closed rail at the
   * platform floor however small the scale makes it". The rail went (PO ruling 2026-09-27);
   * the floor is still honoured for every composition by "never asks for a window narrower than
   * the platform will make" below, which now asserts it on a display too small for the Panel.
   */
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
    // AMENDED for #635 (was: 90, the v4 frame; then 104 with the rail). The
    // redesigned plate: both edge margins, the padding, the nav and one gap.
    for (const height of [DESIGN_COMPOSITION_HEIGHT, 1392]) {
      expect(panelBaseWidth(height) - secondaryColumnWidth(height)).toBe(78)
    }
  })

  it('returns whole pixels, because Electron bounds take nothing else', () => {
    for (const height of [601, 769, 1033, 1393]) {
      expect(Number.isInteger(mineColumnWidth(height))).toBe(true)
      expect(Number.isInteger(secondaryColumnWidth(height))).toBe(true)
      expect(Number.isInteger(panelBaseWidth(height))).toBe(true)
    }
    expect(Number.isInteger(dockSlotWidth())).toBe(true)
  })
})

/*
 * ADDED for #635. The redesigned Panel's grid (screens/shell.md, Layout and
 * Parts): the nav column at the screen edge, the page column beside it, and the
 * mine column between them while a mine is open, on one rock plate with a 6px
 * padding and 6px gaps, held 2px off the screen edge. AMENDED for #635 (PO
 * ruling 2026-09-27): the closed rail that stood on the free side of every
 * composition is gone, and the dock's window slot stands there instead while
 * something is docked in it.
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
    // APPENDED for #635: the dock (`.dm-dock` gap 12px) and its window slot, as wide as the
    // history panel it holds (`.dm-hist` width 440px), with the room its own raised material
    // draws outside it (`.m-mat` 2px edge, `.m-raised` 4px drop shadow).
    expect(DOCK_GAP).toBe(12)
    expect(DOCK_WIDTH).toBe(440)
    expect(DOCK_FREE_ROOM).toBe(6)
  })

  // AMENDED for #635 (was: "…the page and the rail", 544 with the rail and its gap).
  it('spends the opened width on the plate, the nav and the page', () => {
    // 2 + 6 + 56 + 6 + 440 + 6 + 2: the edge margin, the padding, the nav, the
    // gap, the page, the padding and the plate's own frame edge on the free side.
    expect(panelBaseWidth(DESIGN_SCREEN_HEIGHT)).toBe(518)
    expect(panelBaseWidth(1392)).toBe(518)
  })

  /*
   * ADDED for #635. The design's own dock at its reference viewport (screens/shell.md, Full-screen
   * references): the Panel shell is 820 wide with a mine open and 514 without one, which is the
   * plate this window holds between its two 2px edges.
   */
  it('holds the design’s own shell between its two edges', () => {
    expect(panelBaseWidth(DESIGN_SCREEN_HEIGHT) - 2 * SHELL_EDGE_MARGIN).toBe(514)
    expect(
      panelBaseWidth(DESIGN_SCREEN_HEIGHT) +
        mineColumnWidth(DESIGN_SCREEN_HEIGHT) -
        2 * SHELL_EDGE_MARGIN
    ).toBe(820)
  })

  it('adds the dock’s gap, its slot and the room its raised edge is drawn in', () => {
    // The plate's own free-side 2px edge now falls inside the 12px gap, so the
    // slot adds the gap less that edge, the slot, and the slot's own outside room.
    expect(dockSlotWidth()).toBe(DOCK_GAP - SHELL_EDGE_MARGIN + DOCK_WIDTH + DOCK_FREE_ROOM)
    expect(dockSlotWidth()).toBe(456)
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

  /*
   * REMOVED for #635, stated here rather than passing unseen: "keeps the mine column and the nav,
   * without the page, when only the page closes". The page never closes in the design; the
   * rail's arrow that closed it is gone (PO ruling 2026-09-27).
   */

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
    // APPENDED for #635: the dock slot the renderer draws beside the shell.
    expect(px('dock-gap')).toBe(DOCK_GAP)
    expect(px('dock-width')).toBe(DOCK_WIDTH)
    expect(px('dock-free-room')).toBe(DOCK_FREE_ROOM)
    // And the renderer's own copy of the height they leave the mine column.
    expect(SHELL_CONTENT_INSET).toBe(2 * DOCK_INSET + 2 * SHELL_PADDING)
  })

  it('composes the same design width on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      // AMENDED for #635 (was: the mine-only composition as the third): every one there is now.
      for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
        expect(panelWidth(AT_1X, layout, platform)).toBe(panelWidth(AT_1X, layout, 'win32'))
      }
    }
  })
})

describe('panelBounds', () => {
  // AMENDED for #635 (was: "hangs the closed rail on the right edge by default", and its left
  // twin): the window a Panel opens as is the Panel itself, the rail having gone.
  it('hangs the Panel on the right edge by default', () => {
    const width = panelWidth(AREA, OPEN)
    expect(panelBounds(AREA, 'right', OPEN, 'win32')).toEqual({
      x: 1920 - width,
      y: 0,
      width,
      height: 1032
    })
  })

  it('hangs the Panel on the left edge when that is the docked side', () => {
    expect(panelBounds(AREA, 'left', OPEN, 'win32')).toEqual({
      x: 0,
      y: 0,
      width: panelWidth(AREA, OPEN),
      height: 1032
    })
  })

  it('grows inward from the docked edge when it opens', () => {
    // The docked edge does not move: a right-docked panel keeps its right edge
    // against the screen and reaches left. AMENDED for #635 (was: from the
    // closed rail): a mine opening, and then something docked beside it.
    const open = panelBounds(AREA, 'right', OPEN)
    for (const layout of [OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
      const grown = panelBounds(AREA, 'right', layout)
      expect(grown.x + grown.width).toBe(open.x + open.width)
      expect(grown.x).toBe(1920 - panelWidth(AREA, layout))
    }
  })

  it('grows inward from the left edge too, with the left edge pinned', () => {
    for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
      const open = panelBounds(AREA, 'left', layout)
      expect(open.x).toBe(0)
      expect(open.width).toBe(panelWidth(AREA, layout))
    }
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
      // AMENDED for #635: the rail's composition left this list; the docked slot's joined it.
      for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
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
        // AMENDED for #635: the rail's composition left this list; the docked slot's joined it.
        for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
          const bounds = panelBounds(area, edge, layout)
          expect(bounds.x).toBeGreaterThanOrEqual(area.x)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
        }
      }
    }
  })

  /*
   * Windows refuses to make a window narrower than 32px — measured on the
   * maintainer's machine, where a 20px rail came back 32px wide. The floor is
   * requested here so both edges get the same window.
   */
  it('never asks for a window narrower than the platform will make', () => {
    // AMENDED for #465: asserted for each platform's own floor rather than for
    // the Windows one everywhere, which is the untruth that issue removes.
    // AMENDED for #635: the closed rail was the one composition narrower than
    // the floor, and it is gone, so the floor is asserted on a display whose
    // scale shrinks the whole Panel below it.
    const tiny = { x: 0, y: 0, width: 1920, height: 20 }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const edge of ['left', 'right'] as const) {
        const bounds = panelBounds(tiny, edge, OPEN, platform)
        expect(bounds.width).toBeGreaterThanOrEqual(minWindowWidth(platform))
      }
    }
  })

  it('stays on the display it was handed, negative origins included', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    // AMENDED for #635 (was: the closed rail at the platform floor).
    expect(panelBounds(secondary, 'right', OPEN, 'win32').x).toBe(-panelWidth(secondary, OPEN))
    expect(panelBounds(secondary, 'left', OPEN).x).toBe(-1920)
  })

  it('returns whole pixels, which is all Electron accepts for bounds', () => {
    const odd = { x: 0, y: 0, width: 1367, height: 769 }
    for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
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
      expect(panelBaseWidth(height) + mineColumnWidth(height)).toBeGreaterThan(
        panelBaseWidth(height)
      )
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
 * REMOVED for #635, stated rather than passing unseen: 'messagePanelBounds',
 * 'detachedMessagePanelWidth', 'clampMessagePanelBounds', 'detachedMessagePanelBounds' and
 * 'messagePanelPlacement', with the functions they tested: the rectangle of the message panel's own
 * window, docked beside the shell or where a drag left it (#162, #296). The panel is in the
 * shell's dock slot now, whose width 'the redesigned Panel grid' and 'panelBounds' above assert
 * with the rest of the window, and whose height is the dock's.
 */
/*
 * ADDED for #635 (window fit). The mine column is the one width that depends on the height, and
 * the renderer derives it from `100vh`: the window's height over the zoom its page ACTUALLY has.
 * Main used to derive it at the design screen's 1080 instead, which is the same number only while
 * that zoom is exactly `uiScale` — so any page whose zoom drifted drew a column main never
 * reserved, and the page beside it, the one column that gives way, was cut.
 */
describe('one height for the mine column, on both sides', () => {
  /** What the renderer's grid needs, in its own CSS pixels, on a page this tall. */
  function rendererNeeds(
    layout: { mineOpen: boolean; dockOpen: boolean },
    viewportHeight: number
  ): number {
    return (
      2 * SHELL_EDGE_MARGIN +
      2 * SHELL_PADDING +
      NAV_WIDTH +
      SHELL_GAP +
      PAGE_WIDTH +
      (layout.mineOpen ? interiorColumnWidth(viewportHeight) + SHELL_GAP : 0) +
      (layout.dockOpen ? dockSlotWidth() : 0)
    )
  }

  it('derives the column from the height the page is actually zoomed to', () => {
    // A page that refused its zoom: 1392 CSS pixels tall, so its painting is wider than 300px.
    const area = { x: 0, y: 0, width: 2560, height: 1392 }
    expect(panelWidth(area, OPEN_WITH_MINE, 'win32', 1)).toBe(
      panelBaseWidth(1392) + mineColumnWidth(1392)
    )
  })

  /** The work areas the diagnosis ran, in physical pixels, and the OS scales each is shown at. */
  const WORK_AREAS = [
    [1920, 1040],
    [1366, 728],
    [2560, 1392],
    [3840, 2080],
    [1536, 824],
    [1280, 680],
    [1440, 860]
  ] as const
  const OS_SCALES = [1, 1.25, 1.5, 2]

  it('gives the renderer the width its grid draws on every display, whatever zoom the page got', () => {
    for (const [physicalWidth, physicalHeight] of WORK_AREAS) {
      for (const osScale of OS_SCALES) {
        const area = {
          x: 0,
          y: 0,
          width: Math.floor(physicalWidth / osScale),
          height: Math.floor(physicalHeight / osScale)
        }
        // The zoom main asks for, and a page whose zoom drifted either way from it.
        for (const drift of [1, 0.8, 1.25]) {
          const zoom = uiScale(area) * drift
          for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
            const needs = rendererNeeds(layout, area.height / zoom)
            const window = panelWidth(area, layout, 'win32', zoom)
            if (window === area.width) continue // the narrow-screen rule, pinned above
            // Within the rounding of one window pixel: Electron bounds are whole pixels, and half of
            // one is this many CSS pixels on a page zoomed this far.
            const halfWindowPixel = 0.5 / zoom + 1e-9
            expect(
              Math.abs(window / zoom - needs),
              `${area.width}x${area.height} drift ${drift}`
            ).toBeLessThanOrEqual(halfWindowPixel)
          }
        }
      }
    }
  })
})

/*
 * ADDED for #635 (window fit). The renderer draws the columns main REPORTS, so a window that did
 * not reach the width asked of it — a window manager refusing the grow, a compositor clamping it —
 * must be reported as the layout it can hold. Otherwise the renderer draws the mine column into a
 * window without room for it, and the page, the one column that gives way, is cut.
 */
describe('the layout a window can hold', () => {
  const area = { x: 0, y: 0, width: 2560, height: 1392 }
  const zoom = uiScale(area)
  const widthOf = (layout: { mineOpen: boolean; dockOpen: boolean }): number =>
    panelWidth(area, layout, 'win32', zoom)

  it('keeps every column of a window that got the width it asked for', () => {
    for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
      expect(layoutThatFits(area, layout, widthOf(layout), 'win32', zoom)).toEqual(layout)
    }
  })

  it('drops the mine column from a window that refused to grow for it', () => {
    expect(layoutThatFits(area, OPEN_WITH_MINE, widthOf(OPEN), 'win32', zoom)).toEqual(OPEN)
  })

  it('drops the dock before the mine when the window only grew as far as the mine', () => {
    expect(layoutThatFits(area, OPEN_WITH_BOTH, widthOf(OPEN_WITH_MINE), 'win32', zoom)).toEqual(
      OPEN_WITH_MINE
    )
  })

  it('never adds a column nobody asked for, however wide the window stayed', () => {
    expect(layoutThatFits(area, OPEN, widthOf(OPEN_WITH_BOTH), 'win32', zoom)).toEqual(OPEN)
  })

  it('keeps the narrow-screen rule: a window clamped to its display holds what it was asked', () => {
    const portrait = { x: 0, y: 0, width: 1080, height: 1880 }
    const clamped = panelWidth(portrait, OPEN_WITH_BOTH, 'win32')
    expect(clamped).toBe(portrait.width)
    expect(layoutThatFits(portrait, OPEN_WITH_BOTH, clamped, 'win32')).toEqual(OPEN_WITH_BOTH)
  })
})
