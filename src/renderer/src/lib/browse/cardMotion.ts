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

/*
 * The card's own stylesheet transitions `transform` over --dur-press with --ease-step, for its
 * press (mine-card.css). The engine drives `x` and `y` on its JS driver, which writes `transform`
 * inline every frame, and each write restarted that stepped transition before its first step: in
 * the live app the card never moved (#635). So the motion suspends it inline for as long as it owns
 * the card, and hands it back with the rest when the card settles.
 */

/**
 * The enter's first frame, written inline before the card is ever painted: without it the card
 * showed at full opacity for a frame before the engine's first one (#635).
 */
export function holdEnterFrame(element: HTMLElement): void {
  element.style.transition = 'none'
  element.style.opacity = '0'
  element.style.transform = 'translateY(6px)'
}

/** Hand the card back to its stylesheet once it has risen, or appears without rising. */
export function releaseEnterFrame(element: HTMLElement): void {
  element.style.removeProperty('transition')
  element.style.removeProperty('opacity')
  element.style.removeProperty('transform')
}

/** Suspend the card's own transition before it leaves: it starts from the frame it shows. */
export function armExit(element: HTMLElement): void {
  element.style.transition = 'none'
}

/** The exit's last frame, written inline so the card holds it until it is removed. */
export function holdExitFrame(element: HTMLElement): void {
  element.style.transition = 'none'
  element.style.opacity = '0'
  element.style.transform = 'translateX(-8px)'
}
