import { describe, expect, it } from 'vitest'
import {
  STACK_OPEN_MOTION,
  openScrollTop,
  slideFrames,
  stackOpenMs,
  unrollFrames
} from './stackOpen'

/*
 * How the pinned chat stack opens a chat (US-VALLE-007.AC08; Valle QA VQA-01, owner check 2026-10-24): one list scrolls,
 * the opened chat is brought into view head first, and it unrolls over `--dur-panel` unless motion is reduced. Pure.
 */
describe('opening a chat in the pinned stack (VQA-01)', () => {
  const view = { scrollTop: 100, height: 300 }

  it('[US-VALLE-007.AC08] an opened chat wholly in view scrolls nothing; one above the view lines its head up with the top of the list', () => {
    expect(openScrollTop(view, { top: 100, height: 300 })).toBeNull()
    expect(openScrollTop(view, { top: 150, height: 120 })).toBeNull()
    expect(openScrollTop(view, { top: 40, height: 120 })).toBe(40)
    expect(openScrollTop(view, { top: 40, height: 500 })).toBe(40)
  })

  it('[US-VALLE-007.AC08] an opened chat below the view lines its foot up with the foot of the list, its composer shown', () => {
    expect(openScrollTop(view, { top: 350, height: 200 })).toBe(250)
  })

  it('[US-VALLE-007.AC08] an opened chat taller than the list shows its head first, never scrolled past it', () => {
    expect(openScrollTop(view, { top: 350, height: 500 })).toBe(350)
    expect(openScrollTop({ scrollTop: 0, height: 300 }, { top: 0, height: 400 })).toBeNull()
  })

  it('[US-VALLE-007.AC08] the opening plays over --dur-panel with --ease-out, and not at all under reduced motion', () => {
    expect(STACK_OPEN_MOTION).toEqual({ durationMs: 180, easing: 'cubic-bezier(0.2, 0.7, 0.1, 1)' })
    expect(stackOpenMs(false)).toBe(180)
    expect(stackOpenMs(true)).toBe(0)
  })

  it('[US-VALLE-007.AC08] the opened chat unrolls from its head down, and a line slides from where it was', () => {
    expect(unrollFrames()).toEqual([
      { clipPath: 'inset(0 0 100% 0)' },
      { clipPath: 'inset(0 0 0 0)' }
    ])
    expect(slideFrames(-52)).toEqual([{ transform: 'translateY(-52px)' }, { transform: 'none' }])
  })
})
