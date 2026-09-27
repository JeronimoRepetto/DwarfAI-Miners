/*
 * How the dock's window slot opens and closes (#635; motion.md, Transitions: "MessagePanel window
 * (Panel)", played by `openWindow` in the prototype). The slot stands on the plate's outer side, so
 * "its far side, away from the shell" is the free side of the dock on both edges: the left of a
 * right dock and the right of a left one. The docs print the travel and the durations; the values
 * below are those tokens, which dockMotion.test.ts pins to design-tokens.css.
 *
 * Transform and opacity only, through the bounded runner. Under reduced motion the runner answers
 * `still` and the caller takes its instant path. Replacing what an open slot holds is a fade with
 * no travel in the design; the slot holds only the history today, which never replaces itself (it
 * closes with its mine), so that motion arrives with the MessagePanel and the Add panel.
 */
import type { DOMKeyframesDefinition } from 'motion-v'
import type { MotionTransition } from './motionTiming'
import type { PanelEdge } from '../../types'

export interface DockWindowMotion {
  keyframes: DOMKeyframesDefinition
  transition: MotionTransition
}

/** --dur-panel and --ease-out: opening, from 12px on its far side. */
const OPEN: { travel: number; transition: MotionTransition } = {
  travel: 12,
  transition: { duration: 0.18, ease: [0.2, 0.7, 0.1, 1] }
}

/** --dur-fast and --ease-in: closing, 8px toward the shell, holding its last frame. */
const CLOSE: { travel: number; transition: MotionTransition } = {
  travel: 8,
  transition: { duration: 0.09, ease: [0.5, 0, 0.9, 0.3] }
}

/**
 * Closing with its mine (motion.md, "Mine column leaves"): the open window is removed at once,
 * 0ms and no travel, before the column fades.
 */
const AT_ONCE: DockWindowMotion = { keyframes: { opacity: [1, 0] }, transition: { duration: 0 } }

/**
 * The slot's motion, opening or closing, for the edge the Panel docks to. Toward the shell is
 * toward the screen edge: rightward on a right dock, leftward on a left one.
 */
export function dockWindowMotion(
  leaving: boolean,
  edge: PanelEdge,
  options: { withMine?: boolean } = {}
): DockWindowMotion {
  const towardShell = edge === 'right' ? 1 : -1
  if (leaving && options.withMine === true) return AT_ONCE
  if (leaving)
    return {
      keyframes: { opacity: [1, 0], x: [0, towardShell * CLOSE.travel] },
      transition: CLOSE.transition
    }
  return {
    keyframes: { opacity: [0, 1], x: [-towardShell * OPEN.travel, 0] },
    transition: OPEN.transition
  }
}
