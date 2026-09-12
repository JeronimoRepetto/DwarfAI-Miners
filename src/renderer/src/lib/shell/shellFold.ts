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
 * Two rules carry the whole file:
 *
 * - The kept strip is a WIDTH held against the DOCKED edge, stated as
 *   `calc(100% - w)` on the free side. Never a position, and never the
 *   survivors' bounding box — the rail is the free-most column and survives
 *   every fold, so their box is the whole shell however much closes inside it.
 *   Never a measured pixel inset either: main resizes the window under the
 *   running animation, and a percentage keeps the strip against the edge that
 *   did not move.
 * - A column that leaves takes its own width AND one gap with it, because the
 *   row is anchored on the docked edge and everything on the free side of it
 *   slides over.
 */
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
): Keyframe[] {
  return [
    { clipPath: shellFoldClip(from, edge, radius) },
    { clipPath: shellFoldClip(to, edge, radius) }
  ]
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
