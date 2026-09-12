import { describe, expect, it } from 'vitest'
import { foldedShellWidth, shellFoldClip, shellFoldKeyframes } from './shellFold'

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
