/*
 * How the dock's window slot opens and closes (#635; motion.md, Transitions: "MessagePanel window
 * (Panel)", played by `openWindow` in the prototype). The slot stands on the plate's outer side, so
 * "its far side, away from the shell" is the free side of the dock on both edges: the left of a
 * right dock and the right of a left one. The docs print the travel and the durations; the values
 * below are those tokens, which dockMotion.test.ts pins to design-tokens.css.
 *
 * Transform and opacity only, through the bounded runner. Under reduced motion the runner answers
 * `still` and the caller takes its instant path. Replacing what an open slot holds — a chat for the
 * history, the Add panel for a chat, one dwarf's chat for another's — is a fade with no travel, the
 * old content removed at once (dockReplaceMotion).
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

/** --dur-base and --ease-out: the slot's content replaced, a fade with no travel. */
const REPLACE: DockWindowMotion = {
  keyframes: { opacity: [0, 1] },
  transition: { duration: 0.14, ease: [0.2, 0.7, 0.1, 1] }
}

/**
 * What an open slot does when what it holds is replaced (motion.md, "MessagePanel window
 * (Panel)", "its content replaced"): the old content is removed at once, and the new one fades in
 * where it stood, with no travel.
 */
export function dockReplaceMotion(leaving: boolean): DockWindowMotion {
  return leaving ? AT_ONCE : REPLACE
}
