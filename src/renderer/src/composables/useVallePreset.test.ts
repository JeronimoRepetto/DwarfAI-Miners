import type { DwarfId, MineId, MoveToModeParams, UiPreferencesMap } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { defaultValleLayouts, type ValleFacts, type ValleLayouts } from '../lib/valle/preset'
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
    // AMENDED for ISSUE-301: a dive also patches the session's scroll and dive target (A-N18).
    patchUiSession: () => {},
    moveToMode: (params) => {
      moves.push(params)
      return Promise.resolve({ ok: true })
    }
  }
  return { bridge, stored, writes, moves }
}

// AMENDED for ISSUE-301 (was: `{ enterableMine: true }`): machine 28's facts name the mines, the mosaic, the last mine
// worked in, the mosaic's scroll and the chat in focus, which the dive reads (07 S28.03, S28.06).
const FACTS: ValleFacts = {
  mines: [{ mineId: MINE, enterable: true }],
  mosaic: [MINE],
  lastMine: MINE,
  scrollLeft: 0,
  focus: null
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
        facts: () => FACTS
      })
    )!
    expect(preset.send({ kind: 'tab', preset: 'front' })).toBe(true)
    // AMENDED for ISSUE-301 (was: only `vallePreset`): the Work front tab dives into the last mine worked in, written
    // as such (07 S28.06, N-15); with no motion given the dive settles at once.
    expect(fake.stored).toEqual({ vallePreset: 'front', valleLastFrontMineId: MINE })
    expect(preset.send({ kind: 'fold' })).toBe(true)
    expect(fake.stored.valleLayout).toEqual({ ...LEFT, front: { ...LEFT.front, foldedList: true } })
    expect(preset.send({ kind: 'unfold' })).toBe(true)
    expect(fake.stored.valleLayout).toEqual(LEFT)
    // A page and a resize write nothing; a refused input writes nothing.
    expect(preset.send({ kind: 'nav', page: 'map' })).toBe(true)
    expect(preset.send({ kind: 'fold' })).toBe(false)
    expect(fake.writes).toEqual([
      'vallePreset',
      'valleLastFrontMineId',
      'valleLayout',
      'valleLayout'
    ])

    expect(
      preset.send({ kind: 'leave', move: { mode: 'panel', mineId: MINE, dwarfId: DWARF } })
    ).toBe(true)
    expect(fake.moves).toEqual([{ mode: 'panel', mineId: MINE, dwarfId: DWARF }])
    expect(preset.view.value.preset).toBe('front')
    scope.stop()
  })

  it("[US-VALLE-008.AC01, S30.01, S30.02] the split wish is written at once with the Work front layout, the Control room's untouched", () => {
    const fake = fakeBridge()
    const scope = effectScope()
    const left: ValleLayouts = { ...LEFT, front: { ...LEFT.front, split: false } }
    const preset = scope.run(() =>
      useVallePreset({
        bridge: fake.bridge,
        stores: shallowRef(storesWith({ preset: 'front', layout: left })),
        facts: () => FACTS
      })
    )!
    preset.wishSplit(true)
    expect(fake.stored.valleLayout).toEqual({ ...left, front: { ...left.front, split: true } })
    expect(preset.view.value.layouts.front.split).toBe(true)
    // The next layout write keeps the wish.
    preset.send({ kind: 'fold' })
    expect(fake.stored.valleLayout?.front).toEqual({ ...left.front, split: true, foldedList: true })
    preset.wishSplit(false)
    expect(fake.stored.valleLayout?.front.split).toBe(false)
    // The same wish again writes nothing.
    preset.wishSplit(false)
    expect(fake.writes).toEqual(['valleLayout', 'valleLayout', 'valleLayout'])
    scope.stop()
  })

  it('[S28.25, S28.02] after Reset metrics the stores read again open the Control room on its defaults', async () => {
    const fake = fakeBridge()
    const stores = shallowRef(storesWith({ preset: 'front', layout: LEFT }))
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({ bridge: fake.bridge, stores, facts: () => FACTS })
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

// APPENDED for ISSUE-304: a zone's content is the layouts' own (14 §3.9 `zones`, `zone`; 07 machine 31), written at
// once with them (TC-304-01).
describe('the zones written with the layouts (ISSUE-304)', () => {
  it('[S31.03, S31.05, US-VALLE-009.AC01] a zone content written through the view updates the layouts and writes them at once', () => {
    const fake = fakeBridge()
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({
        bridge: fake.bridge,
        stores: shallowRef(storesWith({ preset: 'control', layout: LEFT })),
        facts: () => FACTS
      })
    )!
    const zoned: ValleLayouts = {
      ...LEFT,
      control: { ...LEFT.control, zones: { [MINE]: { content: 'history' } } }
    }
    preset.writeLayouts(zoned)
    expect(preset.view.value.layouts).toEqual(zoned)
    expect(fake.stored.valleLayout).toEqual(zoned)
    // The same layouts again write nothing.
    preset.writeLayouts(preset.view.value.layouts)
    expect(fake.writes).toEqual(['valleLayout'])
    scope.stop()
  })
})

// APPENDED for ISSUE-309: "Reset preset" writes the preset's defaults through this one writer of `valleLayout`
// (07 machine 37; S37.05, S37.06).
describe('the reset layouts written through the one writer (ISSUE-309)', () => {
  it("[US-VALLE-010.AC04, S37.05] reset layouts apply to the view at once and are written through A-N21, the other preset's layout as it was", async () => {
    const fake = fakeBridge()
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({
        bridge: fake.bridge,
        stores: shallowRef(storesWith({ preset: 'control', layout: LEFT })),
        facts: () => FACTS
      })
    )!
    const reset: ValleLayouts = { ...LEFT, control: defaultValleLayouts().control }
    const written = preset.resetLayouts(reset)
    expect(preset.view.value.layouts).toEqual(reset)
    expect(preset.view.value.layouts.front).toBe(LEFT.front)
    expect(fake.stored.valleLayout).toEqual(reset)
    await expect(written).resolves.toBe(true)
    expect(fake.writes).toEqual(['valleLayout'])
    scope.stop()
  })

  it('[S37.06] a failed layout write still leaves the defaults applied for the session and answers false', async () => {
    const fake = fakeBridge()
    const failing: VallePresetBridge = {
      ...fake.bridge,
      setUiPreference: () => Promise.reject(new Error('store down'))
    }
    const scope = effectScope()
    const preset = scope.run(() =>
      useVallePreset({
        bridge: failing,
        stores: shallowRef(storesWith({ preset: 'front', layout: LEFT })),
        facts: () => FACTS
      })
    )!
    const reset: ValleLayouts = { ...LEFT, front: defaultValleLayouts().front }
    await expect(preset.resetLayouts(reset)).resolves.toBe(false)
    expect(preset.view.value.layouts).toEqual(reset)
    scope.stop()
  })
})
