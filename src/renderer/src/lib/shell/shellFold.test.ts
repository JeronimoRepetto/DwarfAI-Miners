import { describe, expect, it } from 'vitest'
import {
  foldedRailOffset,
  foldedShellWidth,
  railFoldKeyframes,
  railFoldTransform,
  shellFoldClip,
  shellFoldKeyframes
} from './shellFold'

/*
 * The three compositions at the design world's own height (1080), so the
 * arithmetic below can be checked against main's: 1001 is the whole book, 438
 * the mine mock (`mineOnlyWidth`), 645 the open page (`expandedWidth`), and 20
 * the design's bare rail.
 */
const BOOK = 1001
const MINE_ONLY = 438
const PAGES_ONLY = 645
const SECONDARY = 555
const NAVIGATION = 38
const MINE_COLUMN = 348
const RAIL = 20

/*
 * ADDED for #464. The same book as rects rather than widths, which is the only
 * form that can answer where the fold's end keyframe leaves each column: 8px of
 * padding, then rail, secondary, navigation and mine with a gap between each,
 * across a right-docked shell whose docked edge is therefore x = 1001.
 */
const ROW = {
  rail: { left: 8, right: 28 },
  secondary: { left: 36, right: 591 },
  navigation: { left: 599, right: 637 },
  mine: { left: 645, right: 993 }
}

interface Span {
  left: number
  right: number
}

/** The strip `kept` px of a `width`-wide right-docked shell paints. */
const strip = (width: number, kept: number): Span => ({ left: width - kept, right: width })
const holds = (within: Span, column: Span): boolean =>
  column.left >= within.left && column.right <= within.right
const moved = (column: Span, travel: number): Span => ({
  left: column.left + travel,
  right: column.right + travel
})

describe('shellFoldClip', () => {
  it('paints the whole shell as a zero inset, so an unfolded ground is uncut', () => {
    expect(shellFoldClip('whole', 'right', '12px')).toBe('inset(0px 0px 0px 0px round 12px)')
    expect(shellFoldClip('whole', 'left', '12px')).toBe('inset(0px 0px 0px 0px round 12px)')
  })

  /*
   * The strip is held against the DOCKED edge and measured from it, never
   * positioned from the free one: the window keeps its docked edge and takes
   * its pixels off the free side, so a fold anchored anywhere else would end
   * where the window is about to stop being.
   */
  it('holds the kept strip against the docked edge, insetting the free side', () => {
    expect(shellFoldClip(36, 'right', '12px')).toBe(
      'inset(0px 0px 0px calc(100% - 36px) round 12px)'
    )
    expect(shellFoldClip(36, 'left', '12px')).toBe(
      'inset(0px calc(100% - 36px) 0px 0px round 12px)'
    )
  })

  /*
   * A percentage rather than the measured width, because the shell's own box
   * changes under the animation: main resizes the window while the fold runs,
   * and a pixel inset measured before that would cut the wrong column.
   */
  it('states the free-side inset against the shell’s own box, not a measurement of it', () => {
    expect(shellFoldClip(20, 'right', '0px')).toContain('calc(100% - 20px)')
  })

  it('draws the fold’s corners with the radius it was handed', () => {
    expect(shellFoldClip(20, 'right', '4px')).toContain('round 4px')
  })
})

describe('shellFoldKeyframes', () => {
  it('folds from what is painted now to what survives the change', () => {
    expect(shellFoldKeyframes('whole', 36, 'right', '12px')).toEqual([
      { clipPath: 'inset(0px 0px 0px 0px round 12px)' },
      { clipPath: 'inset(0px 0px 0px calc(100% - 36px) round 12px)' }
    ])
  })

  it('unfolds from the previous footprint back to the whole ground', () => {
    expect(shellFoldKeyframes(20, 'whole', 'left', '12px')).toEqual([
      { clipPath: 'inset(0px calc(100% - 20px) 0px 0px round 12px)' },
      { clipPath: 'inset(0px 0px 0px 0px round 12px)' }
    ])
  })
})

describe('foldedShellWidth', () => {
  /*
   * The shell is a row anchored on its docked edge, so a column that goes takes
   * its own width AND the gap beside it, and everything on its free side slides
   * over. The survivors' bounding box is no answer at all: the rail is the
   * free-most column and survives every fold, so that box is the whole shell
   * however much closes inside it.
   */
  it('takes each leaving column’s own width and the gap beside it', () => {
    expect(
      foldedShellWidth({ width: BOOK, leaving: [SECONDARY], gap: 8, padding: 8, remaining: 'mine' })
    ).toBe(MINE_ONLY)
    expect(
      foldedShellWidth({
        width: BOOK,
        leaving: [MINE_COLUMN],
        gap: 8,
        padding: 8,
        remaining: 'pages'
      })
    ).toBe(PAGES_ONLY)
  })

  it('subtracts every column leaving in the same change', () => {
    expect(
      foldedShellWidth({
        width: BOOK,
        leaving: [SECONDARY, NAVIGATION, MINE_COLUMN],
        gap: 8,
        padding: 8,
        remaining: 'pages'
      })
    ).toBe(36)
  })

  it('keeps the shell whole when nothing is leaving', () => {
    expect(
      foldedShellWidth({ width: BOOK, leaving: [], gap: 8, padding: 8, remaining: 'pages' })
    ).toBe(BOOK)
  })

  /*
   * `.shell.is-rail` paints no ground at all: the 8px padding the open
   * compositions reserve goes with them, and what is left is the design's bare
   * 20px rail. Folding to the padded 36 would leave an amber strip the
   * collapsed shell is never going to draw.
   */
  it('drops the shell’s own padding when the bare rail is what remains', () => {
    expect(
      foldedShellWidth({
        width: BOOK,
        leaving: [SECONDARY, NAVIGATION, MINE_COLUMN],
        gap: 8,
        padding: 8,
        remaining: 'rail'
      })
    ).toBe(20)
    expect(
      foldedShellWidth({
        width: MINE_ONLY,
        leaving: [NAVIGATION, MINE_COLUMN],
        gap: 8,
        padding: 8,
        remaining: 'rail'
      })
    ).toBe(20)
  })

  it('never folds past nothing, whatever it was handed', () => {
    expect(
      foldedShellWidth({ width: 40, leaving: [SECONDARY], gap: 8, padding: 8, remaining: 'rail' })
    ).toBe(0)
  })
})

/*
 * ADDED for #464. The strip is the right WIDTH and always was; what it is not
 * is a strip the surviving columns are inside. The rail stands at the FREE edge
 * of every open composition, which is the end of the shell the fold clips away,
 * so the strip both cut the rail out and reached ~28px past where the panel
 * leaving it actually ends.
 *
 * The strip therefore has to be asserted by CONTAINMENT and not by arithmetic:
 * a subtraction that happens to give the window's next width says nothing about
 * which columns are standing inside it.
 */
describe('the fold’s end keyframe', () => {
  it('folds to a strip that holds the columns that survive, once the rail has travelled', () => {
    const kept = foldedShellWidth({
      width: BOOK,
      leaving: [SECONDARY],
      gap: 8,
      padding: 8,
      remaining: 'mine'
    })
    const ends = strip(BOOK, kept)
    expect(holds(ends, ROW.navigation)).toBe(true)
    expect(holds(ends, ROW.mine)).toBe(true)
    // Where it stands, the rail is outside the strip the fold ends on: that is
    // the fold clipping away the one column that survives every one of them.
    expect(holds(ends, ROW.rail)).toBe(false)
    const travel =
      BOOK - ROW.rail.right - foldedRailOffset({ kept, rail: RAIL, padding: 8, remaining: 'mine' })
    expect(holds(ends, moved(ROW.rail, travel))).toBe(true)
    // And it travels exactly what the window is about to stop being: the column
    // leaving and the gap beside it, no more — a rail that overshot would end
    // inside the navigation stack.
    expect(travel).toBe(SECONDARY + 8)
  })

  /*
   * `.shell.is-rail` paints no ground and docks the rail with `flex-end`, so the
   * rail's resting place is the docked edge itself and the strip is the rail.
   */
  it('rests the rail against the docked edge when the bare rail is what remains', () => {
    const kept = foldedShellWidth({
      width: BOOK,
      leaving: [SECONDARY, NAVIGATION, MINE_COLUMN],
      gap: 8,
      padding: 8,
      remaining: 'rail'
    })
    expect(foldedRailOffset({ kept, rail: RAIL, padding: 8, remaining: 'rail' })).toBe(0)
    const travel = BOOK - ROW.rail.right
    expect(holds(strip(BOOK, kept), moved(ROW.rail, travel))).toBe(true)
  })

  it('leaves the rail where it stands when nothing is leaving', () => {
    const kept = foldedShellWidth({
      width: BOOK,
      leaving: [],
      gap: 8,
      padding: 8,
      remaining: 'pages'
    })
    expect(
      BOOK - ROW.rail.right - foldedRailOffset({ kept, rail: RAIL, padding: 8, remaining: 'pages' })
    ).toBe(0)
  })

  it('never carries the rail past the docked edge, whatever it was handed', () => {
    expect(foldedRailOffset({ kept: 12, rail: RAIL, padding: 8, remaining: 'rail' })).toBe(0)
  })
})

describe('railFoldKeyframes', () => {
  /*
   * A transform, because the rail has to cross the row without relayouting it:
   * the mine interior re-measures its anchors from the box it is given, and the
   * fold exists to leave that box alone until main resizes the window.
   */
  it('travels the rail toward the docked edge of a right-docked shell', () => {
    expect(railFoldKeyframes(0, 563, 'right')).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(563px)' }
    ])
  })

  it('mirrors the travel onto a left-docked shell, whose docked edge is the other one', () => {
    expect(railFoldKeyframes(0, 563, 'left')).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(-563px)' }
    ])
  })

  it('returns the rail to where the row puts it when the shell unfolds', () => {
    expect(railFoldKeyframes(563, 0, 'right')).toEqual([
      { transform: 'translateX(563px)' },
      { transform: 'translateX(0px)' }
    ])
  })

  it('states the settled travel as the transform the rail is left holding', () => {
    expect(railFoldTransform(563, 'right')).toBe('translateX(563px)')
    expect(railFoldTransform(563, 'left')).toBe('translateX(-563px)')
  })
})
