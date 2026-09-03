import { describe, expect, it } from 'vitest'
import { MIN_PANEL_SIZE, PANEL_CHROME } from '../../renderer/src/lib/scene/sceneSizing'
import {
  EXPANDED_WIDTH,
  MINE_COLUMN_WIDTH,
  MINE_SCENE_CHROME_WIDTH,
  RAIL_WIDTH,
  panelBounds,
  panelWidth
} from './panelBounds'

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }

const CLOSED = { expanded: false, mineOpen: false }
const OPEN = { expanded: true, mineOpen: false }
const OPEN_WITH_MINE = { expanded: true, mineOpen: true }

describe('panelWidth', () => {
  it('is the design rail width while closed, whether or not a mine is held open', () => {
    expect(panelWidth(AREA, CLOSED)).toBe(RAIL_WIDTH)
    expect(panelWidth(AREA, { expanded: false, mineOpen: true })).toBe(RAIL_WIDTH)
  })

  it('opens to the derived panel width', () => {
    expect(panelWidth(AREA, OPEN)).toBe(EXPANDED_WIDTH)
  })

  it('adds the mine column when a mine is held open beside the secondary panel', () => {
    expect(panelWidth(AREA, OPEN_WITH_MINE)).toBe(EXPANDED_WIDTH + MINE_COLUMN_WIDTH)
  })

  it('never asks for more width than the display has', () => {
    // Narrower than the design's own composition, which the source does not
    // cover: the panel spans the display rather than hanging off the side.
    const narrow = { x: 0, y: 0, width: 480, height: 600 }
    expect(panelWidth(narrow, OPEN)).toBe(480)
    expect(panelWidth(narrow, OPEN_WITH_MINE)).toBe(480)
    // The rail is smaller than any display, so it is never clamped.
    expect(panelWidth(narrow, CLOSED)).toBe(RAIL_WIDTH)
  })

  it('leaves a display that fits the composition alone', () => {
    const roomy = { x: 0, y: 0, width: 1366, height: 768 }
    expect(panelWidth(roomy, OPEN)).toBe(EXPANDED_WIDTH)
    expect(panelWidth(roomy, OPEN_WITH_MINE)).toBe(EXPANDED_WIDTH + MINE_COLUMN_WIDTH)
  })
})

describe('panelBounds', () => {
  it('hangs the closed rail on the right edge by default', () => {
    expect(panelBounds(AREA, 'right', CLOSED)).toEqual({
      x: 1920 - RAIL_WIDTH,
      y: 0,
      width: RAIL_WIDTH,
      height: 1032
    })
  })

  it('hangs the closed rail on the left edge when that is the docked side', () => {
    expect(panelBounds(AREA, 'left', CLOSED)).toEqual({
      x: 0,
      y: 0,
      width: RAIL_WIDTH,
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
    expect(open.x).toBe(1920 - EXPANDED_WIDTH)
  })

  it('grows inward from the left edge too, with the left edge pinned', () => {
    const open = panelBounds(AREA, 'left', OPEN)
    expect(open.x).toBe(0)
    expect(open.width).toBe(EXPANDED_WIDTH)
  })

  it('spans the usable height it was given, at that rectangle’s own origin', () => {
    const reserved = { x: 0, y: 48, width: 1920, height: 984 }
    for (const layout of [CLOSED, OPEN, OPEN_WITH_MINE]) {
      const bounds = panelBounds(reserved, 'right', layout)
      expect(bounds.y).toBe(48)
      expect(bounds.height).toBe(984)
    }
  })

  it('stays on the display it was handed, negative origins included', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(panelBounds(secondary, 'right', CLOSED).x).toBe(-RAIL_WIDTH)
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
 * Issue #44 gave the panel a floor so the cave could not be dragged below the
 * smallest box every authored anchor still fits in. The floor was a
 * `minWidth`/`minHeight` on a resizable window; the redesigned shell derives its
 * own bounds from the display and is not dragged at all (#90), so the guarantee
 * has to be re-made where the cave now lives: the mine column.
 *
 * These hold the copied numbers to the derivation the same way window.test.ts
 * did — main cannot import a renderer module at runtime, so it carries the
 * numbers and the test is what stops them drifting.
 */
describe('the mine column against the cave the scene was drawn for', () => {
  it('is never narrower than the smallest panel the cave still reads in', () => {
    expect(MINE_COLUMN_WIDTH).toBeGreaterThanOrEqual(MIN_PANEL_SIZE.width)
  })

  it('carries the chrome MineScene actually wraps around the cave', () => {
    expect(MINE_SCENE_CHROME_WIDTH).toBe(PANEL_CHROME.width)
  })

  it('leaves the secondary panel wider than the cave floor as well', () => {
    // The mine is not the only thing mounted in the shell: a mine can be closed
    // and the same scene opened as the whole content column.
    expect(EXPANDED_WIDTH).toBeGreaterThanOrEqual(MIN_PANEL_SIZE.width)
  })
})
