// layer: L2
import { describe, expect, it } from 'vitest'
import { createUiPreferenceMap } from './uiPreferenceMap'

describe('the UI preference map (14 §3.9; ADR-024 items 1, 9)', () => {
  it('[ADR-024] lastMode and resetEpochApplied are refused as UI main’s own, and a key not built is refused, whatever reaches the use case', () => {
    let toggled = 0
    const map = createUiPreferenceMap({
      startWithSystem: {
        stored: () => true,
        toggle: () => ((toggled += 1), { stored: true, refused: false })
      }
    })

    expect(map.set({ key: 'lastMode', value: 'panel' })).toEqual({
      ok: false,
      error: 'ui-main-only'
    })
    expect(map.set({ key: 'resetEpochApplied', value: 2 })).toEqual({
      ok: false,
      error: 'ui-main-only'
    })
    expect(map.set({ key: 'mutedMineIds', value: [] })).toEqual({ ok: false, error: 'not-built' })
    expect(toggled).toBe(0)
    expect(map.get(['lastMode', 'resetEpochApplied', 'startWithSystem'])).toEqual({
      startWithSystem: true
    })
  })
})
