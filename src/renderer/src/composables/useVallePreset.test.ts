import type { DwarfId, MineId, MoveToModeParams, UiPreferencesMap } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { defaultValleLayouts, type ValleLayouts } from '../lib/valle/preset'
import { useVallePreset, type VallePresetBridge } from './useVallePreset'
import { VALLE_STORE_DEFAULTS, type ValleStores } from './useValleStores'

/*
 * Valle's preset in use (ISSUE-300; 07 machine 28; 14 A-N21, A-N13): each change written at once, only the preset that
 * changed, and the lever's move with the chat in focus. The bridge is a hand-written fake standing for UI main's store
 * behind A-N21: it keeps what was written, as `InMemoryUiPreferenceStore` does, so the next open reads it back.
 */
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a11' as MineId
const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a21' as DwarfId

const LEFT: ValleLayouts = {
  control: { chatWidth: 520, split: false, foldedList: false, zones: {} },
  front: { chatWidth: 610, split: true, foldedList: false, zone: { content: 'mine' } }
}

function fakeBridge() {
  const stored: Partial<UiPreferencesMap> = {}
  const writes: string[] = []
  const moves: MoveToModeParams[] = []
  const bridge: VallePresetBridge = {
    setUiPreference: (write) => {
      writes.push(write.key)
      Object.assign(stored, { [write.key]: write.value })
      return Promise.resolve(write)
    },
    moveToMode: (params) => {
      moves.push(params)
      return Promise.resolve({ ok: true })
    }
  }
  return { bridge, stored, writes, moves }
}

const storesWith = (over: Partial<ValleStores>): ValleStores => ({
  ...VALLE_STORE_DEFAULTS,
  ...over
})

describe('the Valle preset in use (ISSUE-300)', () => {
  it("[S28.16, S28.17, S28.21, US-VALLE-001.AC03] each change is written at once through A-N21, the other preset's layout as it was, and ▼ Panel moves with the chat in focus", () => {
    const fake = fakeBridge()
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({
        bridge: fake.bridge,
        stores: shallowRef(storesWith({ preset: 'control', layout: LEFT })),
        facts: () => ({ enterableMine: true })
      })
    )!
    expect(preset.send({ kind: 'tab', preset: 'front' })).toBe(true)
    expect(fake.stored).toEqual({ vallePreset: 'front' })
    expect(preset.send({ kind: 'fold' })).toBe(true)
    expect(fake.stored.valleLayout).toEqual({ ...LEFT, front: { ...LEFT.front, foldedList: true } })
    expect(preset.send({ kind: 'unfold' })).toBe(true)
    expect(fake.stored.valleLayout).toEqual(LEFT)
    // A page and a resize write nothing; a refused input writes nothing.
    expect(preset.send({ kind: 'nav', page: 'map' })).toBe(true)
    expect(preset.send({ kind: 'fold' })).toBe(false)
    expect(fake.writes).toEqual(['vallePreset', 'valleLayout', 'valleLayout'])

    expect(
      preset.send({ kind: 'leave', move: { mode: 'panel', mineId: MINE, dwarfId: DWARF } })
    ).toBe(true)
    expect(fake.moves).toEqual([{ mode: 'panel', mineId: MINE, dwarfId: DWARF }])
    expect(preset.view.value.preset).toBe('front')
    scope.stop()
  })

  it('[S28.25, S28.02] after Reset metrics the stores read again open the Control room on its defaults', async () => {
    const fake = fakeBridge()
    const stores = shallowRef(storesWith({ preset: 'front', layout: LEFT }))
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({ bridge: fake.bridge, stores, facts: () => ({ enterableMine: true }) })
    )!
    expect(preset.view.value).toEqual({ preset: 'front', page: null, layouts: LEFT })
    preset.send({ kind: 'nav', page: 'settings' })
    // UI main rewrote the stores to their defaults; the window read them again (S39.10).
    stores.value = storesWith({ preset: 'control', layout: null })
    await nextTick()
    expect(preset.view.value).toEqual({
      preset: 'control',
      page: null,
      layouts: defaultValleLayouts()
    })
    expect(fake.writes).toEqual([])
    scope.stop()
  })
})
