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

  it('[ADR-024, S21.17] vetaDock is answered once the dock is built, and only UI main writes it', () => {
    const stored = {
      'Q27G2WG4|2560x1440|@1|0,0': { edge: 'left', end: 'start', offset: 40 }
    } as const
    const map = createUiPreferenceMap({ vetaDock: () => stored })
    // The renderer re-reads it after a reset (14 §3.9 usage rule) and on its own: the stored places, as stored.
    expect(map.get(['vetaDock'])).toEqual({ vetaDock: stored })
    // The dock writes it through layoutVeta (A-N23); a renderer's setUiPreference never does (ADR-024 item 9).
    expect(map.set({ key: 'vetaDock', value: {} })).toEqual({ ok: false, error: 'ui-main-only' })
    // Not composed (a build without the Veta window): not answered.
    expect(createUiPreferenceMap({}).get(['vetaDock'])).toEqual({})
  })

  it('[US-SET-002.AC09] A-N21 stores a Mode at launch pick and A-N20 answers it as stored', () => {
    let stored: 'last-used' | 'panel' | 'veta' | 'valle' = 'last-used'
    const map = createUiPreferenceMap({
      modeAtLaunch: {
        get: () => stored,
        set: (value) => (stored = value)
      }
    })
    expect(map.get(['modeAtLaunch'])).toEqual({ modeAtLaunch: 'last-used' })
    for (const pick of ['veta', 'panel', 'last-used'] as const) {
      expect(map.set({ key: 'modeAtLaunch', value: pick })).toEqual({
        ok: true,
        value: { key: 'modeAtLaunch', value: pick }
      })
      expect(map.get(['modeAtLaunch'])).toEqual({ modeAtLaunch: pick })
    }
    // Not composed: neither answered nor written (hidden until built).
    expect(createUiPreferenceMap({}).get(['modeAtLaunch'])).toEqual({})
    expect(createUiPreferenceMap({}).set({ key: 'modeAtLaunch', value: 'veta' })).toEqual({
      ok: false,
      error: 'not-built'
    })
  })
})
