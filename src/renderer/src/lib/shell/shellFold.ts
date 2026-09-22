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
 * The clip that keeps a leaving or entering column's own vanishing point
 * pinned at its DOCKED-side edge while it travels (#566 T5b: the maintainer's
 * own drawing — a drawer sliding into a wall, not a panel fading beside one).
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
 */
export function columnFoldClip(travel: number, edge: PanelEdge): string {
  const inset = `${Math.max(0, travel)}px`
  return edge === 'right' ? `inset(0px ${inset} 0px 0px)` : `inset(0px 0px 0px ${inset})`
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
  edge: PanelEdge
): DOMKeyframesDefinition {
  return {
    ...columnFoldKeyframes(from, to, edge),
    clipPath: [columnFoldClip(from, edge), columnFoldClip(to, edge)]
  }
}
