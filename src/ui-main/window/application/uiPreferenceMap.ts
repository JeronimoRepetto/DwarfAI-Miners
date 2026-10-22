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
}

export interface UiPreferenceMap {
  get(keys: readonly UiPreferenceKey[]): Partial<UiPreferencesMap>
  set(write: UiPreferenceWrite): Outcome<UiPreferenceWrite, UiPreferenceWriteRefusal>
}

/** The keys only UI main writes (14 §3.9). */
const UI_MAIN_ONLY: readonly UiPreferenceKey[] = ['lastMode', 'resetEpochApplied']

/** How a built key is read and, unless UI main alone writes it, written. */
interface ServedKey<K extends UiPreferenceKey> {
  get(): UiPreferencesMap[K]
  set?(value: UiPreferencesMap[K]): UiPreferencesMap[K]
}

type ServedKeys = { [K in UiPreferenceKey]?: ServedKey<K> }

export function createUiPreferenceMap(deps: UiPreferenceMapDeps): UiPreferenceMap {
  const served: ServedKeys = {}
  const { startWithSystem, vetaDock, modeAtLaunch } = deps
  if (startWithSystem !== undefined) {
    served.startWithSystem = {
      get: () => startWithSystem.stored(),
      set: (value) => startWithSystem.toggle(value).stored
    }
  }

  if (vetaDock !== undefined) served.vetaDock = { get: vetaDock }
  if (modeAtLaunch !== undefined) served.modeAtLaunch = modeAtLaunch

  return {
    get(keys) {
      const answer: Partial<Record<UiPreferenceKey, unknown>> = {}
      for (const key of keys) {
        const entry = served[key]
        if (entry !== undefined) answer[key] = entry.get()
      }
      return answer as Partial<UiPreferencesMap>
    },
    set(write) {
      if (UI_MAIN_ONLY.includes(write.key)) return { ok: false, error: 'ui-main-only' }
      const entry = served[write.key] as ServedKey<typeof write.key> | undefined
      if (entry === undefined) return { ok: false, error: 'not-built' }
      if (entry.set === undefined) return { ok: false, error: 'ui-main-only' }
      return {
        ok: true,
        value: { key: write.key, value: entry.set(write.value) } as UiPreferenceWrite
      }
    }
  }
}
