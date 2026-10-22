// The UiPreferenceStore conformance suite (16 §4.14, 17 §1.3): run against InMemoryUiPreferenceStore and against
// JsonUiPreferenceStore over a per-test temporary folder, for each of the six stores (TC-048-01) and the UiPreferencesMap
// keys built so far (`startWithSystem`, ISSUE-060; `resetEpochApplied`, ISSUE-061; `lastMode`, ISSUE-284; `vetaDock`, ISSUE-286;
// `modeAtLaunch`, ISSUE-294; the six Valle stores, ISSUE-299).
import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { defaultsOf } from '../domain/uiPreferenceValues'
import type {
  UiPreferenceLogRecord,
  UiPreferenceStore,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../ports/uiPreferenceStore'

export interface UiPreferenceStoreSubject {
  /** A new store instance over the subject's one storage (for the JSON adapter: the same folder). */
  open(): UiPreferenceStore
  /** Puts unreadable bytes where the subject keeps `key`. */
  corrupt(key: UiPreferenceStoreKey): void
  /** The next save is cut off half-way through writing its bytes, as by a crash or a full disk. */
  interruptNextSave(): void
  /** Every log record the subject's stores wrote, in order. */
  logged(): readonly UiPreferenceLogRecord[]
}

/** A mine and a dwarf for the Valle stores' values (ISSUE-299). */
const VALLE_MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
const VALLE_DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
const VALLE_OTHER_MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a03' as MineId

/** A value other than the defaults for every store, each in its stored form. */
export const NON_DEFAULT_VALUES: UiPreferenceStoreMap = {
  audio: {
    musicAtStartup: false,
    musicVolume: 0.25,
    ambienceVolume: 0.5,
    voiceVolume: 0.3,
    notificationSounds: false
  },
  typography: {
    style: 'custom',
    faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'roboto' }
  },
  launchView: { area: 'mines', mineId: 'mine-7' },
  dockSide: 'left',
  alwaysOnTop: false,
  shortcut: 'Control+Alt+K',
  startWithSystem: false,
  resetEpochApplied: 2,
  lastMode: 'veta',
  modeAtLaunch: 'veta',
  vetaDock: {
    'Q27G2WG4|2560x1440|@1|0,0': { edge: 'left', end: 'start', offset: 40 },
    '|1920x1080|@1.25|2560,0': { edge: 'top', end: 'end', offset: 0 }
  },
  valleLayout: {
    control: {
      chatWidth: 380,
      split: true,
      foldedList: false,
      zones: { [VALLE_MINE]: { content: 'map' } }
    },
    front: { chatWidth: 420, split: false, foldedList: true, zone: { content: 'mine' } }
  },
  vallePreset: 'front',
  valleLastFrontMineId: VALLE_MINE,
  valleMosaicOrder: [VALLE_MINE],
  pins: [{ dwarfId: VALLE_DWARF, mineId: VALLE_MINE, order: 0 }],
  mutedMineIds: [VALLE_MINE]
}

/** A second stored value per store, different from both the defaults and `NON_DEFAULT_VALUES`. */
const OTHER_VALUES: UiPreferenceStoreMap = {
  audio: { ...NON_DEFAULT_VALUES.audio, musicVolume: 0.9 },
  typography: {
    style: 'readable',
    faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
  },
  launchView: { area: 'lab', mineId: null },
  dockSide: 'right',
  alwaysOnTop: true,
  shortcut: 'Control+Shift+J',
  startWithSystem: true,
  resetEpochApplied: 3,
  lastMode: 'valle',
  modeAtLaunch: 'panel',
  vetaDock: { 'Q27G2WG4|2560x1440|@1|0,0': { edge: 'bottom', end: 'end', offset: 16 } },
  valleLayout: {
    control: { chatWidth: 400, split: false, foldedList: false, zones: {} },
    front: {
      chatWidth: 360,
      split: true,
      foldedList: false,
      zone: { content: 'history', mineId: VALLE_MINE }
    }
  },
  // A preset has two values: the other one is the default.
  vallePreset: 'control',
  valleLastFrontMineId: VALLE_OTHER_MINE,
  valleMosaicOrder: [],
  pins: [],
  mutedMineIds: [VALLE_OTHER_MINE, VALLE_MINE]
}

export const STORE_KEYS = Object.keys(NON_DEFAULT_VALUES) as UiPreferenceStoreKey[]

function saveAll(store: UiPreferenceStore, values: UiPreferenceStoreMap): void {
  for (const key of STORE_KEYS) store.save(key, values[key])
}

export function runUiPreferenceStoreContract(
  makeSubject: () => UiPreferenceStoreSubject | Promise<UiPreferenceStoreSubject>
): void {
  describe('UiPreferenceStore contract', () => {
    it('[ADR-024] a saved value loads back unchanged after a new store instance opens the same folder', async () => {
      const subject = await makeSubject()
      saveAll(subject.open(), NON_DEFAULT_VALUES)

      const reopened = subject.open()
      for (const key of STORE_KEYS) expect(reopened.load(key)).toEqual(NON_DEFAULT_VALUES[key])
      expect(subject.logged()).toEqual([])
    })

    it('[ADR-024] a save writes a temp file and renames it; an interrupted save leaves the previous file intact', async () => {
      const subject = await makeSubject()
      const store = subject.open()
      saveAll(store, NON_DEFAULT_VALUES)

      for (const key of STORE_KEYS) {
        subject.interruptNextSave()
        expect(() => store.save(key, OTHER_VALUES[key])).toThrow()
        expect(subject.open().load(key)).toEqual(NON_DEFAULT_VALUES[key])
      }
      // Each failed write is logged once, by store name (19 §9.6 `uiprefs.write-failed`).
      expect(subject.logged().map((r) => [r.event, r.msg])).toEqual(
        STORE_KEYS.map((key) => ['uiprefs.write-failed', key])
      )
      // The next save after an interrupted one is stored whole.
      saveAll(store, OTHER_VALUES)
      for (const key of STORE_KEYS) expect(subject.open().load(key)).toEqual(OTHER_VALUES[key])
    })

    it('[FM-053] a corrupt file loads the store’s defaults, is logged, and leaves the other stores untouched', async () => {
      for (const corrupted of STORE_KEYS) {
        const subject = await makeSubject()
        saveAll(subject.open(), NON_DEFAULT_VALUES)
        subject.corrupt(corrupted)

        const reopened = subject.open()
        for (const key of STORE_KEYS) {
          expect(reopened.load(key)).toEqual(
            key === corrupted ? defaultsOf(key) : NON_DEFAULT_VALUES[key]
          )
        }
        expect(subject.logged()).toEqual([
          { level: 'warn', event: 'uiprefs.corrupt', subsystem: 'window', msg: corrupted }
        ])
        // The corrupt file is replaced on the next save (FM-053 recovery).
        reopened.save(corrupted, NON_DEFAULT_VALUES[corrupted])
        expect(subject.open().load(corrupted)).toEqual(NON_DEFAULT_VALUES[corrupted])
      }
    })

    it('[US-SET-002.AC10] a store never written loads "Start with the system" ON and logs nothing', async () => {
      const subject = await makeSubject()

      expect(subject.open().load('startWithSystem')).toBe(true)
      expect(subject.logged()).toEqual([])
    })

    it('[ADR-024] a store never written loads resetEpochApplied 0, so the first reset epoch is newer, and logs nothing', async () => {
      const subject = await makeSubject()

      expect(subject.open().load('resetEpochApplied')).toBe(0)
      expect(subject.logged()).toEqual([])
    })

    it('[S10.01, ADR-024] a store never written loads lastMode panel and logs nothing', async () => {
      const subject = await makeSubject()

      expect(subject.open().load('lastMode')).toBe('panel')
      expect(subject.logged()).toEqual([])
    })

    it('[US-SET-002.AC09, S10.01] a store never written loads Mode at launch Last used and logs nothing', async () => {
      const subject = await makeSubject()

      expect(subject.open().load('modeAtLaunch')).toBe('last-used')
      expect(subject.logged()).toEqual([])
    })
  })
}
