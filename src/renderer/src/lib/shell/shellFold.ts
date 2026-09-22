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
 *   to the place the row is about to put it, and `foldedRailOffset` is where
 *   that is. Which is also the one thing the window may not do for it: a resize
 *   removes pixels from an EDGE, and the rail is painted inside the band about
 *   to go, so it has to be out of that band before main shrinks.
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
 * Where the rail comes to rest, measured from the DOCKED edge (#464).
 *
 * The docked edge is the one main never moves, so it is the only thing a
 * position may be stated against — the free edge is by definition the one that
 * is about to be somewhere else. Everything on the free side of a leaving
 * column slides over when it goes, and the rail is the only column that is ever
 * on that side, which makes this the whole of the row's rearrangement.
 *
 * `padding` goes with the open compositions exactly as it does above: the bare
 * rail is docked by `.shell.is-rail { justify-content: flex-end }` with no
 * ground and no padding around it, so it ends flush against the edge itself.
 */
export function foldedRailOffset(shell: {
  /** The strip the fold ends on, from `foldedShellWidth`. */
  kept: number
  /** The rail's own width. */
  rail: number
  /** The shell's own padding, which only the open compositions reserve. */
  padding: number
  /** The composition that will stand once the fold has finished. */
  remaining: ShellComposition
}): number {
  const padding = shell.remaining === 'rail' ? 0 : shell.padding
  return Math.max(0, shell.kept - padding - shell.rail)
}

/**
 * The rail's travel, mirrored on `edge` — travelling toward the docked side is
 * travelling the other way on a left-docked shell. Shared by `railFoldTransform`
 * (the inline style `place` writes) and `railFoldKeyframes` (the motion-v `x`
 * shortcut this file hands the runner), so the two can never mirror the sign
 * differently from each other.
 */
export function railFoldOffset(travel: number, edge: PanelEdge): number {
  return edge === 'right' ? travel : -travel
}

/**
 * The rail's travel, as the transform it is left holding.
 *
 * A transform because it is a compositor property, which is the same rule the
 * clip is chosen under: the mine interior re-measures its anchors from the box
 * it is given, and the fold exists to leave that box alone until main resizes
 * the window around it.
 */
export function railFoldTransform(travel: number, edge: PanelEdge): string {
  return `translateX(${railFoldOffset(travel, edge)}px)`
}

/**
 * The rail's travel from where it is now to where the change leaves it, in
 * motion-v's own shape: `x` is its transform shortcut, driven as a plain
 * number rather than the CSS string `railFoldTransform` writes inline.
 */
export function railFoldKeyframes(
  from: number,
  to: number,
  edge: PanelEdge
): DOMKeyframesDefinition {
  return { x: [railFoldOffset(from, edge), railFoldOffset(to, edge)] }
}
