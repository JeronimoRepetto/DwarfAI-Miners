/*
 * How the Control room's pinned chat stack opens a chat (US-VALLE-007.AC08; `DS/docs/components.md` organisms/chat-stack;
 * `DS/prototype/organisms/chat-stack/chat-stack.js` render; Valle QA VQA-01, owner check 2026-10-24). Pure.
 *
 * - One list scrolls: the lines above, the open chat and the lines below scroll together, so scrolling carries the open
 *   chat with it. Opening a chat scrolls the list as little as it can to bring it into view, its head first: a chat
 *   wholly in view moves nothing; one above lines its head up with the list's top; one below lines its foot up with the
 *   list's foot, never past its head when it is taller than the list.
 * - The motion is the prototype's, which reflows by FLIP and never animates height: every line slides from where it was
 *   to where it is, and the chat that opened unrolls from its head down over the same time, so the lines under it are
 *   pushed open with it. Only `transform` and `clip-path` animate. Reduced motion opens it at once.
 */
import { VALLE_MOTION } from './flip'

/** The list's viewport: how far it is scrolled and how tall it shows, in its content coordinates. */
export interface StackViewport {
  readonly scrollTop: number
  readonly height: number
}

/** The opened chat in the list's content coordinates. */
export interface StackItem {
  readonly top: number
  readonly height: number
}

/** The `scrollTop` that brings the opened chat into view, its head first, or `null` when it already is. */
export function openScrollTop(viewport: StackViewport, item: StackItem): number | null {
  const bottom = item.top + item.height
  const viewBottom = viewport.scrollTop + viewport.height
  if (item.top >= viewport.scrollTop && bottom <= viewBottom) return null
  if (item.top < viewport.scrollTop) return item.top
  // Taller than the list with its head already at the top: it stays, head first.
  const target = Math.min(item.top, bottom - viewport.height)
  return target === viewport.scrollTop ? null : target
}

/** The motion's timing: `--dur-panel` and `--ease-out` (`DS/docs/motion.md`; the prototype's `DM.motion.ms('dur-panel')`). */
export const STACK_OPEN_MOTION = {
  durationMs: 180,
  easing: VALLE_MOTION.easeOut
} as const

/** The open motion's length: none under reduced motion, where every duration token reads 0 ms. */
export function stackOpenMs(reduced: boolean): number {
  return reduced ? 0 : STACK_OPEN_MOTION.durationMs
}

/** The opened chat unrolls from its head down. */
export function unrollFrames(): Keyframe[] {
  return [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }]
}

/** A line slides from where it was, `dy` pixels away, to where it is. */
export function slideFrames(dy: number): Keyframe[] {
  return [{ transform: `translateY(${dy}px)` }, { transform: 'none' }]
}
