import { defaultsOf, migrateTwoChoiceTypography } from '../../domain/uiPreferenceValues'
import type {
  UiPreferenceLogRecord,
  UiPreferenceStore,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../uiPreferenceStore'

/**
 * What an `InMemoryUiPreferenceStore` keeps, shared by every instance opened over it (the double's "folder"). A test
 * seeds it and reads it back: `corrupt` plays an unreadable file, `twoChoiceTypography` plays the older two-choice
 * typography file, `interruptNextSave` cuts the next save off, `logged` collects the store's log records.
 */
export interface InMemoryUiPreferenceStorage {
  readonly stored: Partial<UiPreferenceStoreMap>
  readonly corrupt: Set<UiPreferenceStoreKey>
  twoChoiceTypography?: unknown
  interruptNextSave: boolean
  readonly logged: UiPreferenceLogRecord[]
}

export function createInMemoryUiPreferenceStorage(): InMemoryUiPreferenceStorage {
  return { stored: {}, corrupt: new Set(), interruptNextSave: false, logged: [] }
}

/** Hand-written double of `UiPreferenceStore` (16 §4.14, 16 §2.8); it passes `runUiPreferenceStoreContract`. */
export class InMemoryUiPreferenceStore implements UiPreferenceStore {
  constructor(
    readonly storage: InMemoryUiPreferenceStorage = createInMemoryUiPreferenceStorage()
  ) {}

  load<K extends UiPreferenceStoreKey>(k: K): UiPreferenceStoreMap[K] {
    const { stored, corrupt } = this.storage
    if (corrupt.has(k)) {
      this.storage.logged.push({
        level: 'warn',
        event: 'uiprefs.corrupt',
        subsystem: 'window',
        msg: k
      })
      return defaultsOf(k)
    }
    const value = stored[k]
    if (value !== undefined) return structuredClone(value as UiPreferenceStoreMap[K])
    if (k === 'typography' && this.storage.twoChoiceTypography !== undefined) {
      return migrateTwoChoiceTypography(this.storage.twoChoiceTypography) as UiPreferenceStoreMap[K]
    }
    return defaultsOf(k)
  }

  save<K extends UiPreferenceStoreKey>(k: K, v: UiPreferenceStoreMap[K]): void {
    if (this.storage.interruptNextSave) {
      this.storage.interruptNextSave = false
      this.storage.logged.push({
        level: 'warn',
        event: 'uiprefs.write-failed',
        subsystem: 'window',
        msg: k
      })
      throw new Error(`InMemoryUiPreferenceStore: the save of ${k} was interrupted`)
    }
    this.storage.stored[k] = structuredClone(v)
    this.storage.corrupt.delete(k)
  }
}
