import { describe, expect, it } from 'vitest'
import { acceleratedValues } from 'motion-v'
import {
  columnFoldClip,
  columnFoldKeyframes,
  columnFoldTransform,
  columnSlideKeyframes,
  foldedColumnOffset,
  foldedShellWidth,
  mirrorTravel,
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
    expect(shellFoldKeyframes('whole', 36, 'right', '12px')).toEqual({
      clipPath: [
        'inset(0px 0px 0px 0px round 12px)',
        'inset(0px 0px 0px calc(100% - 36px) round 12px)'
      ]
    })
  })

  it('unfolds from the previous footprint back to the whole ground', () => {
    expect(shellFoldKeyframes(20, 'whole', 'left', '12px')).toEqual({
      clipPath: [
        'inset(0px calc(100% - 20px) 0px 0px round 12px)',
        'inset(0px 0px 0px 0px round 12px)'
      ]
    })
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
      BOOK -
      ROW.rail.right -
      foldedColumnOffset({ kept, before: [], gap: 8, own: RAIL, padding: 8, remaining: 'mine' })
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
    expect(
      foldedColumnOffset({ kept, before: [], gap: 8, own: RAIL, padding: 8, remaining: 'rail' })
    ).toBe(0)
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
      BOOK -
        ROW.rail.right -
        foldedColumnOffset({ kept, before: [], gap: 8, own: RAIL, padding: 8, remaining: 'pages' })
    ).toBe(0)
  })

  it('never carries the rail past the docked edge, whatever it was handed', () => {
    expect(
      foldedColumnOffset({ kept: 12, before: [], gap: 8, own: RAIL, padding: 8, remaining: 'rail' })
    ).toBe(0)
  })

  /*
   * ADDED for #566 T5b. The mine column docks beyond the navigation stack, so
   * when it is what leaves, the navigation stack — not only the rail — stands
   * free of it and has to come to rest somewhere too. `before` is what makes
   * that the SAME formula rather than a second one for "not the free-most
   * column": every survivor still standing between this one and the free
   * edge (the rail AND the secondary panel, here — both nearer the free edge
   * than the navigation stack) is subtracted first, the same way the rail's
   * own call subtracts nothing because nothing ever stands ahead of it.
   */
  it('rests a column that is not the rail behind everything still free of it', () => {
    const kept = foldedShellWidth({
      width: BOOK,
      leaving: [MINE_COLUMN],
      gap: 8,
      padding: 8,
      remaining: 'pages'
    })
    const navigationRests = foldedColumnOffset({
      kept,
      before: [RAIL, SECONDARY],
      gap: 8,
      own: NAVIGATION,
      padding: 8,
      remaining: 'pages'
    })
    // Mine was the last column standing, docked, so once it leaves the
    // navigation stack becomes the new docked-most survivor: flush against
    // the shell's own docked-side padding, and nothing else.
    expect(navigationRests).toBe(8)
    const travel = BOOK - ROW.navigation.right - navigationRests
    // Exactly what the window is about to stop being: the mine column and the
    // gap beside it, no more — the same rule the rail’s own travel proves
    // above, now holding for a column that is not the free-most one either.
    expect(travel).toBe(MINE_COLUMN + 8)
    expect(holds(strip(BOOK, kept), moved(ROW.navigation, travel))).toBe(true)
  })
})

describe('columnFoldKeyframes', () => {
  /*
   * A transform, because a carried column has to cross the row without
   * relayouting it: the mine interior re-measures its anchors from the box it
   * is given, and the fold exists to leave that box alone until main resizes
   * the window.
   *
   * AMENDED for #585 (was motion-v's `x` shortcut). Which KEY carries the
   * travel decides which engine drives it, and that is the whole of the bug:
   * see the case below.
   */
  it('travels a carried column toward the docked edge of a right-docked shell', () => {
    expect(columnFoldKeyframes(0, 563, 'right')).toEqual({
      transform: ['translateX(0px)', 'translateX(563px)']
    })
  })

  it('mirrors the travel onto a left-docked shell, whose docked edge is the other one', () => {
    expect(columnFoldKeyframes(0, 563, 'left')).toEqual({
      transform: ['translateX(0px)', 'translateX(-563px)']
    })
  })

  it('returns a carried column to where the row puts it when the shell unfolds', () => {
    expect(columnFoldKeyframes(563, 0, 'right')).toEqual({
      transform: ['translateX(563px)', 'translateX(0px)']
    })
  })

  /*
   * ADDED for #585, and the reason the key changed at all. motion-dom drives
   * a value on WAAPI only if it is in its own `acceleratedValues` set; `x` is
   * a transform SHORTCUT and is not in it, so it ran on the JS pipeline while
   * `clipPath` — which is — ran on WAAPI. Two engines, two clocks: the probe
   * measured the transform 10% travelled while the clip was 50% through the
   * same run, which painted a column 353px past its own rest edge and clipped
   * the rail away entirely for 14 frames.
   *
   * Asserted against the engine's own set rather than the string 'transform',
   * so a motion-dom that stopped accelerating this key would fail here rather
   * than silently split the run in two again.
   */
  it('carries the travel on a key motion-dom hardware-accelerates, the clip’s own engine', () => {
    for (const key of Object.keys(columnFoldKeyframes(0, 563, 'right'))) {
      expect(acceleratedValues.has(key)).toBe(true)
    }
    expect(acceleratedValues.has('clipPath')).toBe(true)
    expect(acceleratedValues.has('x')).toBe(false)
  })

  it('states the settled travel as the transform a carried column is left holding', () => {
    expect(columnFoldTransform(563, 'right')).toBe('translateX(563px)')
    expect(columnFoldTransform(563, 'left')).toBe('translateX(-563px)')
  })
})

/*
 * ADDED for #566 T5b. The leaving or entering column's own motion: unlike a
 * carried column, it is not free of the box it stood in, so its travel has to
 * stay inside that box rather than paint over the row beside it.
 */
describe('columnFoldClip', () => {
  it('clips nothing at zero travel, the column’s own resting frame', () => {
    expect(columnFoldClip(0, 'right', 'drawer', 8)).toBe('inset(0px 0px 0px 0px)')
    expect(columnFoldClip(0, 'left', 'drawer', 8)).toBe('inset(0px 0px 0px 0px)')
    expect(columnFoldClip(0, 'right', 'uncovered', 8)).toBe('inset(0px 0px 0px 0px)')
    expect(columnFoldClip(0, 'left', 'uncovered', 8)).toBe('inset(0px 0px 0px 0px)')
  })

  /*
   * The DOCKED-side edge is inset, never the free one: composed with the
   * SAME travel on `transform`, the visible sliver stays pinned at the
   * column's own original docked-side edge — the "wall" in the drawing — and
   * narrows away from the free side as the column slides toward it.
   *
   * AMENDED for #585: which side is the wall is now asked rather than
   * assumed. A drawer's wall is the strip docked of it, and this is that
   * case, unchanged.
   */
  it('insets a right-docked drawer to the mouth the strip beside it stands at', () => {
    expect(columnFoldClip(200, 'right', 'drawer', 8)).toBe('inset(0px 192px 0px 0px)')
  })

  it('insets a left-docked drawer to the same mouth, on the other side', () => {
    expect(columnFoldClip(200, 'left', 'drawer', 8)).toBe('inset(0px 0px 0px 192px)')
  })

  /*
   * ADDED for #585 round 2. The two ends of a drawer's own travel, which is
   * what makes the strip's near edge the right line to measure from: at rest
   * it clips nothing (the gap beside it is ground, and ground is what a
   * resting row draws there), and at the end of a travel of its own width plus
   * that gap it has retreated by exactly its own width — fully inside the
   * strip, with the gap standing open again behind it.
   */
  it('clips nothing at rest and exactly the column at the end of its travel', () => {
    expect(columnFoldClip(4, 'right', 'drawer', 8)).toBe('inset(0px 0px 0px 0px)')
    expect(columnFoldClip(555 + 8, 'right', 'drawer', 8)).toBe('inset(0px 555px 0px 0px)')
  })

  /*
   * ADDED for #585, and the other half of the one rule: a column is clipped
   * on the side the navigation strip stands on. The mine column docks BEYOND
   * that strip, so the strip is on its FREE side and what reveals it is the
   * strip travelling off it — the edge that moves is the free one, and the
   * column itself never translates at all.
   */
  it('insets the free-side edge of a right-docked column the strip uncovers', () => {
    expect(columnFoldClip(200, 'right', 'uncovered', 8)).toBe('inset(0px 0px 0px 200px)')
  })

  it('insets the free-side edge of a left-docked column the strip uncovers', () => {
    expect(columnFoldClip(200, 'left', 'uncovered', 8)).toBe('inset(0px 200px 0px 0px)')
  })

  /*
   * AMENDED for #585 round 3: only a DRAWER clamps at zero. An uncovered
   * column's inset is how far the column covering it has come across its box,
   * and that column starts a whole room away: a negative inset is "not here
   * yet", and the keyframe has to be allowed to say so or the reveal is
   * stretched over the whole run instead of tracking the edge that actually
   * does the covering — the navigation strip appearing over 300ms when the
   * rail crossed it in one frame.
   */
  it('clamps a drawer at zero, and lets an uncovered column say its cover is still a room away', () => {
    expect(columnFoldClip(-5, 'right', 'drawer', 8)).toBe('inset(0px 0px 0px 0px)')
    expect(columnFoldClip(-5, 'right', 'uncovered', 8)).toBe('inset(0px 0px 0px -5px)')
    expect(columnFoldClip(-5, 'left', 'uncovered', 8)).toBe('inset(0px -5px 0px 0px)')
  })
})

describe('columnSlideKeyframes', () => {
  /*
   * AMENDED for #585: `x` was a second engine, not a second key — see
   * `columnFoldKeyframes` above. Both halves are accelerated values now, so
   * "the SAME two keyframes" is finally the same CLOCK as well.
   */
  it('carries the transform and the clip on the SAME two keyframes', () => {
    expect(columnSlideKeyframes(0, 563, 'right', 'drawer', 8)).toEqual({
      transform: ['translateX(0px)', 'translateX(563px)'],
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 555px 0px 0px)']
    })
  })

  it('mirrors both halves onto a left-docked shell together', () => {
    expect(columnSlideKeyframes(0, 200, 'left', 'drawer', 8)).toEqual({
      transform: ['translateX(0px)', 'translateX(-200px)'],
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 0px 0px 192px)']
    })
  })

  /*
   * ADDED for #585. A column the strip uncovers has NO travel of its own —
   * that is the whole of what "in place" means: the clip alone answers for
   * it, on the free-side edge the strip is sweeping across, and its box never
   * moves so the interior inside it is never asked to re-measure.
   */
  it('gives an uncovered column the clip alone, with no travel of its own', () => {
    expect(columnSlideKeyframes(0, 356, 'right', 'uncovered', 8)).toEqual({
      clipPath: ['inset(0px 0px 0px 0px)', 'inset(0px 0px 0px 356px)']
    })
  })

  it('mirrors an uncovered column’s clip onto a left-docked shell, still with no travel', () => {
    expect(columnSlideKeyframes(356, 0, 'left', 'uncovered', 8)).toEqual({
      clipPath: ['inset(0px 356px 0px 0px)', 'inset(0px 0px 0px 0px)']
    })
  })
})

describe('mirrorTravel', () => {
  it('leaves a right-docked shell’s travel as it was handed', () => {
    expect(mirrorTravel(563, 'right')).toBe(563)
  })

  it('flips the sign for a left-docked shell, the same rule the whole file mirrors by', () => {
    expect(mirrorTravel(563, 'left')).toBe(-563)
  })
})
