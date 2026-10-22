// layer: L2
import type {
  DwarfId,
  MineId,
  UiPreferenceKey,
  UiPreferencesMap,
  UiPreferenceWrite
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'
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

// APPENDED for ISSUE-299: the six Valle keys of 14 §3.9, read by the Valle window before its first paint (07 S39.03).
describe('the Valle keys of the UI preference map (ISSUE-299; 07 S39.03, S39.13)', () => {
  const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
  const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
  const LAYOUT: UiPreferencesMap['valleLayout'] = {
    control: {
      chatWidth: 380,
      split: false,
      foldedList: false,
      zones: { [MINE]: { content: 'mine' } }
    },
    front: {
      chatWidth: 420,
      split: true,
      foldedList: true,
      zone: { content: 'mine', mineId: MINE }
    }
  }
  const VALLE_KEYS = [
    'vallePreset',
    'valleLayout',
    'valleMosaicOrder',
    'pins',
    'valleLastFrontMineId',
    'mutedMineIds'
  ] as const satisfies readonly UiPreferenceKey[]
  const stored = (): InMemoryUiPreferenceStore => {
    const store = new InMemoryUiPreferenceStore()
    store.save('vallePreset', 'front')
    store.save('valleLayout', LAYOUT)
    store.save('valleMosaicOrder', [MINE])
    store.save('pins', [{ dwarfId: DWARF, mineId: MINE, order: 0 }])
    store.save('valleLastFrontMineId', MINE)
    store.save('mutedMineIds', [MINE])
    return store
  }

  it('[S39.03, ADR-024] A-N20 answers the stored Valle keys; an unwritten layout is not answered, and a key not written yet is not renderer-writable', () => {
    const map = createUiPreferenceMap({ valle: stored() })
    expect(map.get(VALLE_KEYS)).toEqual({
      vallePreset: 'front',
      valleLayout: LAYOUT,
      valleMosaicOrder: [MINE],
      pins: [{ dwarfId: DWARF, mineId: MINE, order: 0 }],
      valleLastFrontMineId: MINE,
      mutedMineIds: [MINE]
    })
    // Never written: each key's 14 §3.9 default, and no layout at all (machine 33's default applies in the renderer).
    expect(
      createUiPreferenceMap({ valle: new InMemoryUiPreferenceStore() }).get(VALLE_KEYS)
    ).toEqual({
      vallePreset: 'control',
      valleMosaicOrder: null,
      pins: null,
      valleLastFrontMineId: null,
      mutedMineIds: []
    })
    // Each becomes writable in the issue that first writes it. AMENDED for ISSUE-300 (was: `vallePreset` and
    // `valleLayout` refused `not-built` too): ISSUE-300 writes those two, asserted in its own case below.
    // AMENDED for ISSUE-302 (was: `pins` refused here): ISSUE-302 writes the pins; a key still unwritten stands in.
    // AMENDED for ISSUE-304 (was: `mutedMineIds` refused `not-built` on this map): ISSUE-304 writes the last two Valle
    // keys, asserted in its own case below; a Valle key is still refused where the Valle stores are not composed.
    expect(map.set({ key: 'mutedMineIds', value: [] })).toEqual({
      ok: true,
      value: { key: 'mutedMineIds', value: [] }
    })
    expect(createUiPreferenceMap({}).set({ key: 'mutedMineIds', value: [] })).toEqual({
      ok: false,
      error: 'not-built'
    })
  })

  it('[S39.13, FM-053] an unreadable store falls back to its defaults and logs uiprefs.corrupt', () => {
    const store = stored()
    for (const key of ['vallePreset', 'valleLayout', 'pins'] as const)
      store.storage.corrupt.add(key)
    const map = createUiPreferenceMap({ valle: store })
    expect(map.get(VALLE_KEYS)).toEqual({
      vallePreset: 'control',
      valleMosaicOrder: [MINE],
      pins: null,
      valleLastFrontMineId: MINE,
      mutedMineIds: [MINE]
    })
    expect(store.storage.logged).toEqual(
      ['vallePreset', 'valleLayout', 'pins'].map((msg) => ({
        level: 'warn',
        event: 'uiprefs.corrupt',
        subsystem: 'window',
        msg
      }))
    )
  })
})

// APPENDED for ISSUE-300: the Valle window writes the preset in use and each preset's layout (07 machine 28).
describe('the Valle preset and layouts written through A-N21 (ISSUE-300; ADR-024 items 1, 4, 9)', () => {
  const LAYOUT: UiPreferencesMap['valleLayout'] = {
    control: { chatWidth: 0, split: false, foldedList: false, zones: {} },
    front: { chatWidth: 0, split: false, foldedList: true, zone: { content: 'mine' } }
  }

  it('[S28.16, S28.17, S28.26, ADR-024] vallePreset and valleLayout are written into UI main’s store and answered as stored; the other Valle keys stay refused', () => {
    const store = new InMemoryUiPreferenceStore()
    const map = createUiPreferenceMap({ valle: store })
    expect(map.set({ key: 'vallePreset', value: 'front' })).toEqual({
      ok: true,
      value: { key: 'vallePreset', value: 'front' }
    })
    expect(map.set({ key: 'valleLayout', value: LAYOUT })).toEqual({
      ok: true,
      value: { key: 'valleLayout', value: LAYOUT }
    })
    expect(store.load('vallePreset')).toBe('front')
    expect(store.load('valleLayout')).toEqual(LAYOUT)
    // The next open (S28.02) reads back what was written on every change (S28.26).
    expect(createUiPreferenceMap({ valle: store }).get(['vallePreset', 'valleLayout'])).toEqual({
      vallePreset: 'front',
      valleLayout: LAYOUT
    })
    // Each of the others becomes writable in the issue that first writes it (ISSUE-301…ISSUE-310). AMENDED for
    // ISSUE-302 (was: `pins` refused here too): the pins are written from ISSUE-302 on, asserted in its own case.
    // AMENDED for ISSUE-301 (was: `valleLastFrontMineId` refused `not-built` here): the dive writes it, asserted in
    // its own case below.
    // AMENDED for ISSUE-304 (was: `valleMosaicOrder` and `mutedMineIds` refused `not-built` here): both are written
    // from ISSUE-304 on, asserted in its own case below; writing the layouts left them as they were.
    expect(store.load('valleMosaicOrder')).toBeNull()
    expect(store.load('mutedMineIds')).toEqual([])
  })
})

// APPENDED for ISSUE-302: the Valle window writes the pins on every change (07 machine 29; TC-302-01; S29.21).
describe('the Valle pins written through A-N21 (ISSUE-302; ADR-024 items 1, 4, 9)', () => {
  const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
  const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
  const PINS: UiPreferencesMap['pins'] = [{ dwarfId: DWARF, mineId: MINE, order: 0 }]

  // TC-302-01: `pins` is persisted at once.
  it('[S29.08, S29.10, S29.21] pins are written into UI main’s store and answered as stored; a failed write keeps the previous value', () => {
    const store = new InMemoryUiPreferenceStore()
    const map = createUiPreferenceMap({ valle: store })
    expect(map.set({ key: 'pins', value: PINS })).toEqual({
      ok: true,
      value: { key: 'pins', value: PINS }
    })
    expect(createUiPreferenceMap({ valle: store }).get(['pins'])).toEqual({ pins: PINS })
    // S29.21: the store fails the write and logs `uiprefs.write-failed` by name; the previous pins stay stored and
    // the window keeps its set in memory until its next change writes it again.
    store.storage.interruptNextSave = true
    expect(() => map.set({ key: 'pins', value: [] })).toThrow()
    expect(store.load('pins')).toEqual(PINS)
    expect(store.storage.logged).toEqual([
      { level: 'warn', event: 'uiprefs.write-failed', subsystem: 'window', msg: 'pins' }
    ])
    // AMENDED for ISSUE-304 (was: `valleMosaicOrder` refused `not-built` here): written from ISSUE-304 on, asserted in
    // its own case below; the failed pins write left the mosaic order as it was.
    expect(store.load('valleMosaicOrder')).toBeNull()
  })
})

// APPENDED for ISSUE-301: the dive and a Work front swap write the last mine worked in (07 S28.03, S28.15; N-15).
describe('the last mine worked in written through A-N21 (ISSUE-301; ADR-024 items 1, 4, 9)', () => {
  const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId

  it('[S28.02, S28.03, S28.15] valleLastFrontMineId is written into UI main’s store and answered as stored, the next open reading it', () => {
    const store = new InMemoryUiPreferenceStore()
    const map = createUiPreferenceMap({ valle: store })
    expect(map.set({ key: 'valleLastFrontMineId', value: MINE })).toEqual({
      ok: true,
      value: { key: 'valleLastFrontMineId', value: MINE }
    })
    expect(store.load('valleLastFrontMineId')).toBe(MINE)
    expect(createUiPreferenceMap({ valle: store }).get(['valleLastFrontMineId'])).toEqual({
      valleLastFrontMineId: MINE
    })
    // AMENDED for ISSUE-304 (was: `valleMosaicOrder` refused `not-built`, "still another issue's"): written from
    // ISSUE-304 on, asserted in its own case below; the last mine's write left the mosaic order as it was.
    expect(store.load('valleMosaicOrder')).toBeNull()
  })
})

// APPENDED for ISSUE-304: the zone menu and the add slot write the mosaic order and the muted mines (07 machines 31,
// 32; TC-304-01). After it, every Valle key is written by the Valle window.
describe('the mosaic order and the muted mines written through A-N21 (ISSUE-304; ADR-024 items 1, 4, 9)', () => {
  const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId

  // TC-304-01: the mosaic order and the muted mines are persisted at once.
  it('[S32.03, S32.05, S31.08, S32.02] valleMosaicOrder and mutedMineIds are written into UI main’s store and answered as stored, the next open reading them', () => {
    const store = new InMemoryUiPreferenceStore()
    const map = createUiPreferenceMap({ valle: store })
    for (const write of [
      { key: 'valleMosaicOrder', value: [MINE] },
      { key: 'mutedMineIds', value: [MINE] }
    ] satisfies UiPreferenceWrite[]) {
      expect(map.set(write)).toEqual({ ok: true, value: write })
    }
    expect(
      createUiPreferenceMap({ valle: store }).get(['valleMosaicOrder', 'mutedMineIds'])
    ).toEqual({
      valleMosaicOrder: [MINE],
      mutedMineIds: [MINE]
    })
    // An emptied mosaic is stored as emptied, never as "never written" (07 N-22).
    expect(map.set({ key: 'valleMosaicOrder', value: [] })).toEqual({
      ok: true,
      value: { key: 'valleMosaicOrder', value: [] }
    })
    expect(store.load('valleMosaicOrder')).toEqual([])
  })
})
