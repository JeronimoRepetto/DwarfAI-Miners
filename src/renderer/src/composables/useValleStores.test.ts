import type {
  DwarfId,
  MineId,
  UiPreferenceKey,
  UiPreferencesMap,
  UiSessionSnapshot
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import {
  VALLE_STORE_DEFAULTS,
  VALLE_STORE_KEYS,
  readValleStores,
  useValleStores,
  type ValleStoresBridge
} from './useValleStores'

/**
 * The Valle stores (07 S39.03, S39.10; ADR-024 items 1, 4, 8; 14 §3.9 A-N17, A-N20, A-N12): what the Valle window reads
 * before its first paint, and reads again after Reset metrics. The bridge is a hand-written fake whose answers the test
 * settles.
 */
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
const OTHER = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a03' as MineId
const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId

const STORED: Partial<UiPreferencesMap> = {
  vallePreset: 'front',
  valleLayout: {
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
  },
  valleMosaicOrder: [OTHER, MINE],
  pins: [{ dwarfId: DWARF, mineId: MINE, order: 0 }],
  valleLastFrontMineId: MINE,
  mutedMineIds: [OTHER]
}

const SESSION: UiSessionSnapshot = {
  drafts: {},
  chatViews: {},
  askPicks: {},
  openChat: { panel: null, valle: DWARF },
  currentMine: { panel: null, valle: MINE },
  valle: { mosaicScrollLeft: 240, focusedPin: DWARF }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function fakeBridge() {
  const asked: UiPreferenceKey[][] = []
  const prefs: { resolve: (v: Partial<UiPreferencesMap>) => void }[] = []
  const sessions: { resolve: (v: unknown) => void }[] = []
  const resets: ((payload: unknown) => void)[] = []
  const bridge: ValleStoresBridge = {
    getUiPreferences: ({ keys }) => {
      asked.push([...keys])
      const d = deferred<Partial<UiPreferencesMap>>()
      prefs.push(d)
      return d.promise
    },
    getUiSession: () => {
      const d = deferred<unknown>()
      sessions.push(d)
      return d.promise
    },
    onUiPreferencesReset: (listener) => {
      resets.push(listener)
      return () => resets.splice(resets.indexOf(listener), 1)
    }
  }
  return { bridge, asked, prefs, sessions, resets }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('the Valle stores (07 S39.03, S39.10; ISSUE-299)', () => {
  it('[S39.03, ADR-024] the Valle stores and session fields are read before the first paint', async () => {
    const fake = fakeBridge()
    let read: unknown = null
    void readValleStores(fake.bridge).then((stores) => (read = stores))
    // A-N20 for exactly the Valle keys, A-N17 for the session: nothing is ready until both answered.
    expect(fake.asked).toEqual([[...VALLE_STORE_KEYS]])
    expect(VALLE_STORE_KEYS).toEqual([
      'vallePreset',
      'valleLayout',
      'valleMosaicOrder',
      'pins',
      'valleLastFrontMineId',
      'mutedMineIds'
    ])
    fake.prefs[0]!.resolve(STORED)
    await flush()
    expect(read, 'the session is not read yet').toBeNull()
    fake.sessions[0]!.resolve(SESSION)
    await flush()
    expect(read).toEqual({
      preset: 'front',
      layout: STORED.valleLayout,
      mosaicOrder: [OTHER, MINE],
      pins: [{ dwarfId: DWARF, mineId: MINE, order: 0 }],
      lastFrontMineId: MINE,
      mutedMineIds: [OTHER],
      session: {
        valle: { mosaicScrollLeft: 240, focusedPin: DWARF },
        openChat: DWARF,
        currentMine: MINE
      }
    })
  })

  it('[S39.03, ADR-024] a key UI main does not answer, or a read that fails, opens on that store default', async () => {
    const fake = fakeBridge()
    let read: unknown = null
    void readValleStores(fake.bridge).then((stores) => (read = stores))
    // UI main answers no Valle key (never written, or not served), and the session read fails.
    fake.prefs[0]!.resolve({})
    await flush()
    fake.sessions[0]!.resolve({ not: 'a session' })
    await flush()
    expect(read).toEqual(VALLE_STORE_DEFAULTS)
    expect(VALLE_STORE_DEFAULTS).toMatchObject({
      preset: 'control',
      layout: null,
      mosaicOrder: null,
      pins: null,
      lastFrontMineId: null,
      mutedMineIds: []
    })
  })

  it('[S39.10, ADR-024] after Reset metrics the Valle window reads its stores and session again', async () => {
    const fake = fakeBridge()
    const scope = effectScope()
    const part = scope.run(() =>
      useValleStores(fake.bridge, {
        ...VALLE_STORE_DEFAULTS,
        preset: 'front',
        pins: [{ dwarfId: DWARF, mineId: MINE, order: 0 }]
      })
    )!
    expect(part.stores.value.preset).toBe('front')
    // A-N12: UI main rewrote the stores to defaults; the window asks again and applies what it is told.
    fake.resets[0]!({ epoch: 2 })
    expect(fake.asked).toEqual([[...VALLE_STORE_KEYS]])
    fake.prefs[0]!.resolve({ vallePreset: 'control', pins: null, valleMosaicOrder: null })
    await flush()
    fake.sessions[0]!.resolve({ ...SESSION, openChat: {}, currentMine: {}, valle: {} })
    await flush()
    expect(part.stores.value).toEqual(VALLE_STORE_DEFAULTS)
    scope.stop()
    expect(fake.resets).toHaveLength(0)
  })
})
