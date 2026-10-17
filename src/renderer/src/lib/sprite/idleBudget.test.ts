import { describe, expect, it } from 'vitest'
import { readSheetTiming } from './asepriteSidecar'
import { cssLoop, type LoopSpec } from './cssLoop'
import { checkIdleBudget } from './idleBudget'

/*
 * ISSUE-283 (TC-283-01). An idle scene runs one slow CSS loop and nothing on the frame clock. The
 * lantern's art is still owed, so its sidecar here is a four-frame strip with uneven holds, in the
 * shape Aseprite's scripted export writes.
 */
const SIDECAR = {
  frames: [700, 500, 900, 300].map((duration, i) => ({
    filename: `lantern ${i}`,
    frame: { x: i * 16, y: 0, w: 16, h: 24 },
    duration
  })),
  meta: { frameTags: [{ name: 'lantern', from: 0, to: 3 }] }
}

const lantern = (reducedMotion = false): LoopSpec =>
  cssLoop({
    name: 'dm-lantern',
    timing: readSheetTiming(SIDECAR, 4),
    cellWidthPx: 16,
    reducedMotion
  })

describe('idleBudget', () => {
  it('[US-VETA-001.AC06, NFR-PERF-04] an idle scene runs one slow loop of a few frames and subscribes nothing to the frame clock', () => {
    expect(checkIdleBudget({ loops: [lantern()], clockSubscriptions: 0 })).toEqual({ ok: true })
    // Under reduced motion the lantern is a steady light: still the scene's one loop, and in budget.
    expect(checkIdleBudget({ loops: [lantern(true)], clockSubscriptions: 0 })).toEqual({
      ok: true
    })

    // The load-bearing half: a sprite on the frame clock is a timer waking the renderer.
    expect(checkIdleBudget({ loops: [lantern()], clockSubscriptions: 1 })).toEqual({
      ok: false,
      breaches: ['clock-subscription']
    })
  })

  it('[NFR-PERF-04] an idle scene with a second loop or any clock subscription is refused by the budget check', () => {
    expect(checkIdleBudget({ loops: [lantern(), lantern()], clockSubscriptions: 0 })).toEqual({
      ok: false,
      breaches: ['second-loop']
    })
    expect(checkIdleBudget({ loops: [lantern()], clockSubscriptions: 3 })).toEqual({
      ok: false,
      breaches: ['clock-subscription']
    })
    expect(checkIdleBudget({ loops: [lantern(), lantern()], clockSubscriptions: 2 })).toEqual({
      ok: false,
      breaches: ['second-loop', 'clock-subscription']
    })
    expect(checkIdleBudget({ loops: [], clockSubscriptions: 0 })).toEqual({
      ok: false,
      breaches: ['no-loop']
    })

    // A look-alike loop that cssLoop did not build says nothing about timers or properties.
    const forged: LoopSpec = { ...lantern() }
    expect(checkIdleBudget({ loops: [forged], clockSubscriptions: 0 })).toEqual({
      ok: false,
      breaches: ['not-a-css-loop']
    })
  })

  it("[NFR-PERF-04] the idle loop's frames and durations are exactly those of its sidecar", () => {
    const loop = lantern()

    expect(loop.durationsMs).toEqual([700, 500, 900, 300])
    expect(loop.timing).toBe('sidecar')
    expect(loop.cycleMs).toBe(2400)
    // One keyframe per frame plus the closing one: no frame invented, none dropped.
    expect(loop.keyframes).toHaveLength(SIDECAR.frames.length + 1)
    expect(loop.keyframes.map((keyframe) => keyframe.offset * loop.cycleMs)).toEqual([
      0, 700, 1200, 2100, 2400
    ])
    expect(checkIdleBudget({ loops: [loop], clockSubscriptions: 0 })).toEqual({ ok: true })
  })
})
