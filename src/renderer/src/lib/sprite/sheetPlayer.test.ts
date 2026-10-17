import { describe, expect, it } from 'vitest'
import sleepingSidecar from '../../assets/art/sprites/dwarf-foreman-sleeping-v3-Sheet.json'
import { readSheetTiming, type SheetTiming } from './asepriteSidecar'
import { sheetCycleMs, sheetFrameAt } from './sheetPlayer'

// ISSUE-282 (TC-282-01, TC-282-02). A swing shaped like the pick: 120ms, a hurried 60ms, the impact held 200ms.
const SWING: SheetTiming = { durationsMs: [120, 60, 200], timing: 'sidecar' }

describe('sheetPlayer', () => {
  it('[NFR-TIM-10] the frame shown at elapsed time t follows the sidecar durations and wraps at the loop end', () => {
    // Boundary rows at each frame edge: a frame starts exactly where the one before it ends.
    const rows: [elapsedMs: number, frame: number][] = [
      [0, 0],
      [119, 0],
      [120, 1],
      [179, 1],
      [180, 2],
      [379, 2],
      [380, 0],
      [499, 0],
      [500, 1],
      [380 * 7 + 180, 2]
    ]
    for (const [elapsedMs, frame] of rows) {
      expect({ elapsedMs, frame: sheetFrameAt(SWING, elapsedMs, false) }).toEqual({
        elapsedMs,
        frame
      })
    }
  })

  it('[NFR-TIM-10, NFR-A11Y-10] under reduced motion every frame plays at 200 ms whatever the sidecar says', () => {
    const rows: [elapsedMs: number, frame: number][] = [
      [0, 0],
      [199, 0],
      [200, 1],
      [399, 1],
      [400, 2],
      [599, 2],
      [600, 0]
    ]
    for (const [elapsedMs, frame] of rows) {
      expect({ elapsedMs, frame: sheetFrameAt(SWING, elapsedMs, true) }).toEqual({
        elapsedMs,
        frame
      })
    }
    expect(sheetCycleMs(SWING, true)).toBe(600)
  })

  it('[ADR-025] a sleep sheet whose sidecar sums to 2 560 ms completes one cycle in 2 560 ms', () => {
    // The committed foreman sleep sidecar (art bible, foreman/sleeping: 2560ms a cycle).
    const sleeping = readSheetTiming(sleepingSidecar, 12)
    const last = sleeping.durationsMs.length - 1

    expect(sleeping.timing).toBe('sidecar')
    expect(sheetCycleMs(sleeping, false)).toBe(2560)
    expect(sheetFrameAt(sleeping, 2559, false)).toBe(last)
    expect(sheetFrameAt(sleeping, 2560, false)).toBe(0)
  })
})
