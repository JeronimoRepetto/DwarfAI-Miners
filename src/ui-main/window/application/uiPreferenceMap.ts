// A-N20 `getUiPreferences` and A-N21 `setUiPreference` over the UI preference stores (14 §2.2, §3.9
// `UiPreferencesMap`; ADR-024 items 1, 9): the stored value of each asked key, nothing for a key not asked; a write
// answers what was stored, for `startWithSystem` the verified login-entry state, which may differ from the request
// (ADR-027 item 7). A key is served once it is built, here and in the registry's A-N20 / A-N21 schemas; until then it is
// never answered and a write of it is refused (hidden until built, 21 §1 item 8). `lastMode` and `resetEpochApplied`
// are UI main's own: a renderer's write of either is refused (14 §3.9), here as well as by the seam A gate.
import type {
  Outcome,
  UiPreferenceKey,
  UiPreferencesMap,
  UiPreferenceWrite
} from '@dwarfai/contracts'
import type { UiPreferenceStore } from '../ports/uiPreferenceStore'
import type { StartWithSystem } from './startWithSystem'

/** Why a write is refused: a key UI main alone writes, or a key not built in this build. */
export type UiPreferenceWriteRefusal = 'ui-main-only' | 'not-built'

export interface UiPreferenceMapDeps {
  /** "Start with the system" (machine 40); absent while S-027-4 has not passed on this OS (loginEntryGate.ts). */
  startWithSystem?: Pick<StartWithSystem, 'stored' | 'toggle'>
  /**
   * Veta's stored places (`vetaDock`, 07 machine 21; ISSUE-286), answered once the dock is composed. Only UI main writes
   * them, through `layoutVeta` (A-N23): a renderer's write is refused as UI main's own (ADR-024 item 9).
   */
  vetaDock?: () => UiPreferencesMap['vetaDock']
  /**
   * Settings › General "Mode at launch" (14 §3.9; US-SET-002.AC09; ISSUE-294): the stored launch preference, which the
   * renderer reads and writes; the `ModeCoordinator` reads it at the first open (S10.01, S10.13).
   */
  modeAtLaunch?: {
    get(): UiPreferencesMap['modeAtLaunch']
    set(value: UiPreferencesMap['modeAtLaunch']): UiPreferencesMap['modeAtLaunch']
  }
  /**
   * The Valle stores (14 §3.9; 07 S39.03, S39.13; ISSUE-299), answered for the Valle window's first paint. A store the
   * window cannot use loads its defaults and logs `uiprefs.corrupt` (FM-053), and an unwritten layout is not answered.
   * The Valle window writes the preset in use and each preset's layout on every change (07 machine 28; ISSUE-300),
   * UI main storing them (ADR-024 item 9); each other key becomes writable in the issue that first writes it
   * (ISSUE-301…ISSUE-310).
   */
  valle?: Pick<UiPreferenceStore, 'load' | 'save'>
}

export interface UiPreferenceMap {
  get(keys: readonly UiPreferenceKey[]): Partial<UiPreferencesMap>
  set(write: UiPreferenceWrite): Outcome<UiPreferenceWrite, UiPreferenceWriteRefusal>
}

/** The keys only UI main writes (14 §3.9). */
const UI_MAIN_ONLY: readonly UiPreferenceKey[] = ['lastMode', 'resetEpochApplied']

/** The Valle keys A-N20 answers (ISSUE-299). */
const VALLE_KEYS = [
  'valleLayout',
  'vallePreset',
  'valleLastFrontMineId',
  'valleMosaicOrder',
  'pins',
  'mutedMineIds'
] as const satisfies readonly UiPreferenceKey[]

/** The Valle keys the Valle window writes (ISSUE-300; 07 S28.06, S28.11, S28.16, S28.17). */
const VALLE_WRITTEN: readonly UiPreferenceKey[] = ['vallePreset', 'valleLayout']

/**
 * How a built key is read (`undefined`: nothing to answer) and, unless UI main alone writes it, written. A key read here
 * but written by a renderer only from a later issue refuses its write as `not-built`.
 */
interface ServedKey<K extends UiPreferenceKey> {
  get(): UiPreferencesMap[K] | undefined
  set?(value: UiPreferencesMap[K]): UiPreferencesMap[K]
  readOnly?: UiPreferenceWriteRefusal
}

type ServedKeys = { [K in UiPreferenceKey]?: ServedKey<K> }

export function createUiPreferenceMap(deps: UiPreferenceMapDeps): UiPreferenceMap {
  const served: ServedKeys = {}
  const { startWithSystem, vetaDock, modeAtLaunch, valle } = deps
  if (startWithSystem !== undefined) {
    served.startWithSystem = {
      get: () => startWithSystem.stored(),
      set: (value) => startWithSystem.toggle(value).stored
    }
  }

  if (vetaDock !== undefined) served.vetaDock = { get: vetaDock }
  if (modeAtLaunch !== undefined) served.modeAtLaunch = modeAtLaunch
  if (valle !== undefined) {
    const answer = served as Record<
      (typeof VALLE_KEYS)[number],
      ServedKey<(typeof VALLE_KEYS)[number]>
    >
    for (const key of VALLE_KEYS) {
      // A never-written layout (`null`) is not answered: the renderer applies each preset's own defaults.
      // Every other `null` is that key's 14 §3.9 "never written" value, and is answered.
      answer[key] = {
        get: () => {
          const value = valle.load(key)
          return key === 'valleLayout' && value === null ? undefined : value
        },
        ...(VALLE_WRITTEN.includes(key)
          ? {
              set: (value) => {
                // Throws when the write failed, the previous value kept: the seam A answer is then an error.
                valle.save(key, value)
                return value
              }
            }
          : { readOnly: 'not-built' as const })
      }
    }
  }

  return {
    get(keys) {
      const answer: Partial<Record<UiPreferenceKey, unknown>> = {}
      for (const key of keys) {
        const entry = served[key]
        const value = entry?.get()
        if (value !== undefined) answer[key] = value
      }
      return answer as Partial<UiPreferencesMap>
    },
    set(write) {
      if (UI_MAIN_ONLY.includes(write.key)) return { ok: false, error: 'ui-main-only' }
      const entry = served[write.key] as ServedKey<typeof write.key> | undefined
      if (entry === undefined) return { ok: false, error: 'not-built' }
      if (entry.set === undefined) return { ok: false, error: entry.readOnly ?? 'ui-main-only' }
      return {
        ok: true,
        value: { key: write.key, value: entry.set(write.value) } as UiPreferenceWrite
      }
    }
  }
}
