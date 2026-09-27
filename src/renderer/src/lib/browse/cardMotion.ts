/*
 * How a mine card enters and leaves the Mines page (#635, PANEL-QUESTIONS 9, design lead ruling
 * 2026-09-27; motion.md, Transitions: "Mine card enters or leaves"). The prototype plays
 * `DM.motion.enter(card, 'up')` on an added mine's card and `DM.motion.exit(card, 'left')` on a
 * removed one's; the docs never printed the numbers, so they are written here from the tokens,
 * which cardMotion.test.ts pins to design-tokens.css.
 *
 * Transform and opacity only. Under reduced motion both read 0ms: the bounded runner answers
 * `still` and the caller takes its instant path. The cards below a leaving one close the gap at
 * once when it is removed, with no FLIP.
 */
import type { DOMKeyframesDefinition } from 'motion-v'
import type { MotionTransition } from '../shell/motionTiming'

export interface CardMotion {
  keyframes: DOMKeyframesDefinition
  transition: MotionTransition
}

/** --rise, --dur-base and --ease-out: opacity 0 to 1 rising 6px, then it scrolls into view. */
export const MINE_CARD_ENTER: CardMotion = {
  keyframes: { opacity: [0, 1], y: [6, 0] },
  transition: { duration: 0.14, ease: [0.2, 0.7, 0.1, 1] }
}

/** --dur-fast and --ease-in: opacity 1 to 0 sliding 8px left, holding its last frame. */
export const MINE_CARD_EXIT: CardMotion = {
  keyframes: { opacity: [1, 0], x: [0, -8] },
  transition: { duration: 0.09, ease: [0.5, 0, 0.9, 0.3] }
}

/** The exit's last frame, written inline so the card holds it until it is removed. */
export function holdExitFrame(element: HTMLElement): void {
  element.style.opacity = '0'
  element.style.transform = 'translateX(-8px)'
}
