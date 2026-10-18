import { describe, expect, it } from 'vitest'
import { readSheetTiming } from './asepriteSidecar'
import { cssLoop, cssLoopRule, isCssLoop, LOOP_FRAME_EASING } from './cssLoop'

/*
 * ISSUE-283 (TC-283-02). An idle loop is played by the browser from CSS keyframes, so it needs no
 * JavaScript timer. A sidecar in the shape Aseprite's scripted export writes, built here: the
 * lantern's art is still owed, so these are a four-frame strip's own uneven holds.
 */
function exported(durations: number[]): unknown {
  return {
    frames: durations.map((duration, i) => ({
      filename: `lantern ${i}`,
      frame: { x: i * 16, y: 0, w: 16, h: 24 },
      duration
    })),
    meta: { frameTags: [{ name: 'lantern', from: 0, to: durations.length - 1 }] }
  }
}

const LANTERN = readSheetTiming(exported([600, 400, 800, 600]), 4)

describe('cssLoop', () => {
  it('[NFR-TIM-10, NFR-PERF-01] a loop built from a sidecar animates only transform, with keyframe offsets proportional to the sidecar durations', () => {
    const loop = cssLoop({
      name: 'dm-lantern',
      timing: LANTERN,
      cellWidthPx: 16,
      reducedMotion: false
    })

    expect(loop.animated).toBe(true)
    expect(loop.cycleMs).toBe(2400)
    // Each frame starts at the share of the cycle the frames before it hold; the loop closes at 1
    // on its last frame, so that frame holds its own 600ms before the wrap.
    expect(loop.keyframes.map((keyframe) => keyframe.offset)).toEqual([
      0,
      600 / 2400,
      1000 / 2400,
      1800 / 2400,
      1
    ])
    expect(loop.keyframes.map((keyframe) => keyframe.transform)).toEqual([
      'translateX(0px)',
      'translateX(-16px)',
      'translateX(-32px)',
      'translateX(-48px)',
      'translateX(-48px)'
    ])
    for (const keyframe of loop.keyframes) {
      expect(Object.keys(keyframe).sort()).toEqual(['easing', 'offset', 'transform'])
      expect(keyframe.easing).toBe(LOOP_FRAME_EASING)
    }
    expect(isCssLoop(loop)).toBe(true)
  })

  it('[NFR-TIM-10, NFR-PERF-01] the loop renders as a CSS @keyframes rule and an infinite animation of one cycle, with no script driving it', () => {
    const loop = cssLoop({
      name: 'dm-lantern',
      timing: readSheetTiming(exported([600, 600]), 2),
      cellWidthPx: 16,
      reducedMotion: false
    })

    expect(cssLoopRule(loop)).toEqual({
      keyframes:
        '@keyframes dm-lantern { 0% { transform: translateX(0px); animation-timing-function: steps(1, end) } ' +
        '50% { transform: translateX(-16px); animation-timing-function: steps(1, end) } ' +
        '100% { transform: translateX(-16px); animation-timing-function: steps(1, end) } }',
      animation: 'dm-lantern 1200ms linear infinite'
    })
  })

  it('[NFR-A11Y-10] a steady loop renders no @keyframes rule and no animation', () => {
    const loop = cssLoop({
      name: 'dm-lantern',
      timing: LANTERN,
      cellWidthPx: 16,
      reducedMotion: true
    })

    expect(cssLoopRule(loop)).toEqual({ keyframes: '', animation: 'none' })
  })

  it('[NFR-A11Y-10] under reduced motion the idle loop is a steady first frame with no animation', () => {
    const loop = cssLoop({
      name: 'dm-lantern',
      timing: LANTERN,
      cellWidthPx: 16,
      reducedMotion: true
    })

    expect(loop.animated).toBe(false)
    expect(loop.cycleMs).toBe(0)
    expect(loop.keyframes).toEqual([
      { offset: 0, transform: 'translateX(0px)', easing: LOOP_FRAME_EASING }
    ])
    expect(isCssLoop(loop)).toBe(true)
  })
})
