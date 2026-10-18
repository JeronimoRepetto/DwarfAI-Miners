import { describe, expect, it } from 'vitest'
import { readSheetTiming } from './asepriteSidecar'

/*
 * ISSUE-282 (TC-282-01). A sidecar in the shape Aseprite's scripted export writes: one entry per
 * frame with its `duration`, and the sheet's tag under `meta.frameTags`. Built here rather than read
 * off disk; `dwarfSheets.test.ts` holds the committed sidecars against their PNGs.
 */
function exported(durations: number[]): unknown {
  return {
    frames: durations.map((duration, i) => ({
      filename: `sleeping ${i}`,
      frame: { x: i * 36, y: 0, w: 36, h: 38 },
      duration
    })),
    meta: { frameTags: [{ name: 'sleeping', from: 0, to: durations.length - 1 }] }
  }
}

describe('asepriteSidecar', () => {
  it("[NFR-TIM-10] per-frame durations are read from the sheet's Aseprite JSON sidecar", () => {
    const timing = readSheetTiming(exported([220, 200, 320, 160]), 4)

    expect(timing.durationsMs).toEqual([220, 200, 320, 160])
    expect(timing.timing).toBe('sidecar')
  })

  it('[NFR-TIM-10] a sheet without a sidecar plays every frame at 100 ms', () => {
    const timing = readSheetTiming(undefined, 5)

    expect(timing.durationsMs).toEqual([100, 100, 100, 100, 100])
    expect(timing.timing).toBe('default')
  })

  it('[NFR-TIM-10] a malformed sidecar is treated as missing and flagged, never thrown', () => {
    const malformed: unknown[] = [
      null,
      'not json',
      { frames: [] },
      { frames: [{ duration: 0 }, { duration: 120 }] },
      { frames: [{ duration: 'fast' }] },
      { meta: {} }
    ]

    for (const json of malformed) {
      let timing: ReturnType<typeof readSheetTiming> | undefined
      expect(() => (timing = readSheetTiming(json, 3))).not.toThrow()
      expect(timing).toEqual({ durationsMs: [100, 100, 100], timing: 'default' })
    }
  })
})
