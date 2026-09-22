/**
 * The shell folding into its rail, as geometry (#388).
 *
 * The window is frameless and transparent, and main moves its docked edge never
 * and its free edge always: opening adds pixels on the free side, closing takes
 * them off. Those pixels used to be painted at the moment they arrived or went,
 * which is the whole of the flicker #388 reports — the amber ground followed
 * main's APPLIED layout, so it snapped to the new rectangle in one frame while
 * the columns inside it faded on their own 250ms.
 *
 * So the ground is animated instead of the columns, with `clip-path`: a
 * compositor property, which is the only kind allowed here. Animating width or
 * flex would relayout the MineScene inside on every frame, and the cave
 * re-measures its anchors from the box it is given.
 *
 * Three rules carry the whole file:
 *
 * - The kept strip is a WIDTH held against the DOCKED edge, stated as
 *   `calc(100% - w)` on the free side. Never a position, and never a measured
 *   pixel inset: main resizes the window under the running animation, and a
 *   percentage keeps the strip against the edge that did not move.
 * - A column that leaves takes its own width AND one gap with it, because the
 *   row is anchored on the docked edge and everything on the free side of it
 *   slides over.
 * - The strip has to CONTAIN the columns that survive, and the width above is
 *   no promise that it does (#464). The rail stands at the free edge of every
 *   open composition — the end of the shell the fold clips away — so a strip of
 *   exactly the right width cut the rail out and reached a padding and a gap
 *   past the panel that was leaving. The rail therefore travels with the fold,
 *   to the place the row is about to put it, and `foldedColumnOffset` is where
 *   that is. Which is also the one thing the window may not do for it: a resize
 *   removes pixels from an EDGE, and the rail is painted inside the band about
 *   to go, so it has to be out of that band before main shrinks.
 *
 * A fourth rule, added for #566 T5b: the rail is not the only column that can
 * stand on the free side of one that leaves or enters. It is the only one
 * that ALWAYS does — every open composition draws it there — but the mine
 * column dock on the FAR side of the secondary panel and the navigation
 * stack, so when the mine is what leaves or enters, THEY stand free of it
 * too. The comment this replaces claimed the rail was the only column ever
 * on that side; it was true only for a secondary-panel leave, the one case
 * #464 had evidence for, and it read the mine column closing as the
 * secondary panel animating instead — the ground clipped a band under
 * columns nothing was carrying, the mine stayed painted over it, and only
 * the resize that followed a whole IPC round trip later corrected the
 * picture, which is the blink. `foldedColumnOffset`, below, answers "where
 * does THIS column come to rest" for any of them, not only the rail — and
 * the leaving or entering column itself gets a clip of its own
 * (`columnFoldClip`, `columnSlideKeyframes`) for the same reason the ground
 * does: it is not free of the box it is vacating or about to fill, so its
 * own travel has to stay inside that box rather than paint over whatever the
 * row has drawn beside it.
 */
import type { DOMKeyframesDefinition } from 'motion-v'
import type { ShellComposition } from './composition'
import type { PanelEdge } from '../../types'

/**
 * How much of the shell is painted: the whole ground, or that many CSS pixels
 * of it held against the docked edge.
 */
export type ShellFoldState = 'whole' | number

/**
 * The `clip-path` that paints exactly `state` of a shell docked on `edge`.
 *
 * `radius` is the shell's own `border-radius`, read from the element rather
 * than named here, so the clipped corners are the ones the ground is already
 * drawn with and the strip the fold ends on has the rail's shape.
 */
export function shellFoldClip(state: ShellFoldState, edge: PanelEdge, radius: string): string {
  const free = state === 'whole' ? '0px' : `calc(100% - ${state}px)`
  return edge === 'right'
    ? `inset(0px 0px 0px ${free} round ${radius})`
    : `inset(0px ${free} 0px 0px round ${radius})`
}

/** The fold from what is painted now to what the change leaves painted. */
export function shellFoldKeyframes(
  from: ShellFoldState,
  to: ShellFoldState,
  edge: PanelEdge,
  radius: string
): DOMKeyframesDefinition {
  return { clipPath: [shellFoldClip(from, edge, radius), shellFoldClip(to, edge, radius)] }
}

/**
 * How wide the shell's ground is once the columns now leaving are gone.
 *
 * `padding` is only ever spent on the bare rail: `.shell.is-rail` paints no
 * ground at all, so the 8px the open compositions reserve goes with them and
 * what is left is the design's own 20px rail. Folding to the padded 36 would
 * end on an amber strip the collapsed shell is never going to draw.
 */
export function foldedShellWidth(shell: {
  /** The shell's current width, in CSS pixels. */
  width: number
  /** The width of each column leaving in this change. */
  leaving: readonly number[]
  /** `--space-nav-gap` between columns; one goes with each of them. */
  gap: number
  /** The shell's own padding, which only the open compositions reserve. */
  padding: number
  /** The composition that will stand once the fold has finished. */
  remaining: ShellComposition
}): number {
  const kept = shell.leaving.reduce((width, column) => width - column - shell.gap, shell.width)
  return Math.max(0, shell.remaining === 'rail' ? kept - 2 * shell.padding : kept)
}

/**
 * Where a carried column comes to rest, measured from the DOCKED edge (#464,
 * generalized #566 T5b).
 *
 * The docked edge is the one main never moves, so it is the only thing a
 * position may be stated against — the free edge is by definition the one that
 * is about to be somewhere else. Everything on the free side of a leaving or
 * entering column slides over when it goes or arrives; `before` is every OTHER
 * surviving column standing between THIS one and the free edge, in free-to-
 * docked order, so the rail's own call (`before: []`, the whole of #464's
 * answer) and a secondary panel's or the navigation stack's own call (one or
 * two widths ahead of it) share one formula rather than two that happen to
 * agree when there is nothing ahead.
 *
 * `padding` goes with the open compositions exactly as it does above: the bare
 * rail is docked by `.shell.is-rail { justify-content: flex-end }` with no
 * ground and no padding around it, so it ends flush against the edge itself.
 */
export function foldedColumnOffset(shell: {
  /** The strip the fold ends on, from `foldedShellWidth`. */
  kept: number
  /** Every surviving column standing between this one and the free edge. */
  before: readonly number[]
  /** `--space-nav-gap`, spent between every pair of surviving columns. */
  gap: number
  /** This column's own width. */
  own: number
  /** The shell's own padding, which only the open compositions reserve. */
  padding: number
  /** The composition that will stand once the fold has finished. */
  remaining: ShellComposition
}): number {
  const padding = shell.remaining === 'rail' ? 0 : shell.padding
  const clearedFree = shell.before.reduce(
    (width, column) => width - column - shell.gap,
    shell.kept - padding
  )
  return Math.max(0, clearedFree - shell.own)
}

/**
 * A carried column's travel, mirrored on `edge` — travelling toward the docked
 * side is travelling the other way on a left-docked shell (#464, generalized
 * #566 T5b: was named for the rail alone, which is one carried column among
 * now several). Shared by `columnFoldTransform` (the inline style `place`
 * writes) and `columnFoldKeyframes` (the keyframes this file hands the
 * runner), so the two can never mirror the sign differently from each other.
 */
export function mirrorTravel(travel: number, edge: PanelEdge): number {
  return edge === 'right' ? travel : -travel
}

/**
 * A carried column's travel, as the transform it is left holding.
 *
 * A transform because it is a compositor property, which is the same rule the
 * clip is chosen under: the mine interior re-measures its anchors from the box
 * it is given, and the fold exists to leave that box alone until main resizes
 * the window around it.
 */
export function columnFoldTransform(travel: number, edge: PanelEdge): string {
  return `translateX(${mirrorTravel(travel, edge)}px)`
}

/**
 * A carried column's travel from where it is now to where the change leaves
 * it — the SAME `transform` string `columnFoldTransform` writes inline, run
 * as two keyframes.
 *
 * `transform`, and not motion-v's `x` shortcut this used to hand over (#585).
 * Which key a value is named by decides which ENGINE drives it: motion-dom
 * accelerates exactly `opacity`, `clipPath`, `filter`, `transform` and
 * `backgroundColor` onto WAAPI (its own `acceleratedValues`, asserted against
 * in `shellFold.test.ts`), and `x` is in none of them — it is a transform
 * shortcut resolved by motion-dom's own JS driver, on its own rAF clock. So a
 * column asked for `x` AND `clipPath` in one `animate()` call got two
 * animations on two clocks: a real-window probe measured the transform 10%
 * travelled while the clip of the same run was 50% through it, which paints
 * the content 353px past its own rest edge and, closing, clips a column away
 * entirely for a dozen frames. Named as the property WAAPI already drives and
 * the two halves share one timeline, which is the whole of what
 * `columnSlideKeyframes` below claims.
 */
export function columnFoldKeyframes(
  from: number,
  to: number,
  edge: PanelEdge
): DOMKeyframesDefinition {
  return { transform: [columnFoldTransform(from, edge), columnFoldTransform(to, edge)] }
}

/**
 * How a leaving or entering column's own motion reads, which is decided by
 * where the navigation strip stands relative to it (#585).
 *
 * One rule, two answers: **a column is clipped on the side the strip is on.**
 *
 * - `'drawer'` — the strip is on this column's DOCKED side, so that edge is a
 *   fixed mouth the column is pulled out of and pushed back into. It travels,
 *   and it is clipped there. Every column on the free side of the strip is
 *   one of these: the secondary panel, and the strip itself, which has the
 *   window's own docked edge for a wall.
 * - `'uncovered'` — nothing stands docked of this column, so it is what the
 *   rest of the row travels ACROSS: the mine column, which docks beyond the
 *   strip, and the strip itself where there is no mine — the maintainer's own
 *   picture of the rail and the strip as two columns glued together, of which
 *   only the rail moves (#585 round 3). It never translates at all, and the
 *   clip on its free side is the edge of the column covering it, frame by
 *   frame: the strip's over the mine, the rail's over the strip.
 *
 * Which one a column is, is geometry rather than a name: `useShellFold` asks
 * whether anything else in the row stands nearer the docked edge than it does.
 */
export type ColumnFold = 'drawer' | 'uncovered'

/**
 * The clip that keeps a leaving or entering column's own vanishing point
 * pinned at the edge the navigation strip stands on while the change runs
 * (#566 T5b: the maintainer's own drawing — a drawer sliding into a wall, not
 * a panel fading beside one; generalized to both sides of the strip in #585).
 *
 * A carried column (the rail, or a secondary panel and navigation stack
 * carried by a mine closing beside them) is free of the box it stood in: it
 * has nowhere of its own to be clipped against, and `columnFoldTransform`
 * alone is the whole of its motion. The column that is actually leaving or
 * entering is not free of that box — it is still laid out inside it, un-
 * shrunk, until main answers — so sliding it with nothing else changed would
 * paint it over whatever the row has drawn beside it, or past the window's
 * own edge, for as long as the run takes.
 *
 * `travel` is read in the element's OWN local coordinates, insetting exactly
 * that many pixels off the DOCKED-side edge of its box — never a percentage:
 * `shellFoldClip`'s `calc(100% - …)` is stated against the SHELL's box
 * because the window resizes under that animation, and a column's own box
 * never does (`transform` is a paint-time operation; it cannot re-layout the
 * flex item it is applied to). Composed with the transform of the same
 * distance, the visible sliver stays pinned at the column's own original
 * docked-side edge and narrows away from the free-side edge as `travel`
 * grows — the "wall" in the drawing is that docked-side edge, fixed, and the
 * content slides toward and behind it rather than being clipped uniformly.
 *
 * `mouth` is how far the strip this column disappears into stands from the
 * column's own edge by the END of the travel, and it is what the clip is
 * measured to (#585 round 2). Measured from its own edge instead, the
 * drawer's visible side stayed exactly one gap short of the strip in every
 * frame — a real-window probe read the secondary panel's edge at 902.2 while
 * the navigation strip's stood at 910.2 — so the drawer came out of an
 * invisible line with a band of bare ground between it and the thing it is
 * sliding out of. Subtracting the mouth puts the two edges together for the
 * whole travel, and the resting gap comes back on its own at the ends: a
 * travel of 0 clips nothing, and a full travel has retreated by exactly the
 * column's own width, leaving the gap standing open behind it.
 *
 * One gap is the whole of that distance while the strip stays put; where the
 * strip is leaving too, it is one gap plus the room the strip itself is
 * vacating, because the mouth travels with it. `useShellFold` works that
 * distance out from the row and hands it over.
 *
 * An `'uncovered'` column insets the FREE side instead, and has no transform
 * composed with it at all: `travel` there is how far the edge of the column
 * COVERING it has come across its box, frame by frame — the strip sweeping
 * over the mine column, the rail crossing the strip — so the inset IS that
 * edge, over a box that never moves. It is allowed to be negative (#585
 * round 3): a cover a whole room away has not reached the box yet, and the
 * keyframe has to be able to say so, because the two ends of the run are what
 * the engine interpolates between. Clamped to zero, a strip the rail crossed
 * in one frame was instead revealed over its own width for the whole 300ms
 * and read as the strip itself animating. The `mouth` is a drawer's business
 * alone and is ignored here.
 */
export function columnFoldClip(
  travel: number,
  edge: PanelEdge,
  fold: ColumnFold,
  mouth: number
): string {
  // The mouth a drawer disappears into stands that far beyond its own edge,
  // and a drawer clips nothing until it has retreated that far. An uncovered
  // column's inset is the covering edge itself, wherever it stands.
  const inset = `${fold === 'drawer' ? Math.max(0, travel - mouth) : travel}px`
  // The docked side of a right-docked shell is its right, and the free side of
  // a left-docked one is the same edge — so the two folds are each other's
  // mirror, and one expression answers for both docks and both of them.
  const insetRight = fold === 'drawer' ? edge === 'right' : edge === 'left'
  return insetRight ? `inset(0px ${inset} 0px 0px)` : `inset(0px 0px 0px ${inset})`
}

/**
 * The leaving or entering column's OWN motion: `columnFoldKeyframes`'s travel,
 * carrying `columnFoldClip` along on the SAME two keyframes, so one
 * `animate()` call drives both compositor properties in lockstep and neither
 * can finish or watchdog-end ahead of the other (#566 T5b).
 *
 * "In lockstep" only became true with #585: both keys are WAAPI-accelerated
 * values now, so they are one timeline rather than two engines handed the
 * same two keyframes — see `columnFoldKeyframes` above.
 */
export function columnSlideKeyframes(
  from: number,
  to: number,
  edge: PanelEdge,
  fold: ColumnFold,
  mouth: number
): DOMKeyframesDefinition {
  const clipPath = [columnFoldClip(from, edge, fold, mouth), columnFoldClip(to, edge, fold, mouth)]
  // An uncovered column is the one that does NOT slide (#585): its box stays
  // exactly where the row put it and the column covering it does the moving,
  // so a travel of its own would be the second opinion about where it is that
  // this whole file exists to avoid. `from` and `to` are that cover's edge at
  // the two ends of the run, handed over by `useShellFold`, which knows the
  // row.
  if (fold === 'uncovered') return { clipPath }
  return { ...columnFoldKeyframes(from, to, edge), clipPath }
}
