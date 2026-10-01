// The persisted UI preference stores of UI main (ADR-024 items 1, 9; 05 §3.14): each read straight from its store, so
// the launch view is answered before the first paint (S10.01, NFR-PERS-10); each setter stores the value in its one
// stored form and answers what the store then holds; a stored typography reaches every open mode window (A-P6).
import { storedFormOf } from '../domain/uiPreferenceValues'
import type {
  UiPreferenceStore,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../ports/uiPreferenceStore'

/** A-P6 `onTypographyPreferences` (14 §2.1). */
const TYPOGRAPHY_CHANGED = 'typography:preferences:changed'

/** The member of a mode window a push needs (16 §4.14 `ModeWindow.send`: a 14 §2.2 M→R member of that window). */
export interface ModeWindowSender {
  send(push: string, payload: unknown): void
}

export interface UiPreferencesDeps {
  store: UiPreferenceStore
  /** The open mode windows (the Panel today; Veta and Valle with ADR-034). */
  modeWindows(): readonly ModeWindowSender[]
}

/** Typed get and set of each persisted UI preference store (ADR-024 items 1, 9). */
export interface StoredUiPreferences {
  get<K extends UiPreferenceStoreKey>(k: K): UiPreferenceStoreMap[K]
  set<K extends UiPreferenceStoreKey>(k: K, v: UiPreferenceStoreMap[K]): UiPreferenceStoreMap[K]
}

export function createUiPreferences(deps: UiPreferencesDeps): StoredUiPreferences {
  const { store, modeWindows } = deps
  return {
    get: (k) => store.load(k),
    set(k, v) {
      try {
        store.save(k, storedFormOf(k, v))
      } catch {
        // The store logged the failed write (`uiprefs.write-failed`); the answer is what is still stored.
        return store.load(k)
      }
      const stored = store.load(k)
      // A-46 → A-P6: every open mode window draws the stored typography (14 §2.1).
      if (k === 'typography') {
        for (const window of modeWindows()) window.send(TYPOGRAPHY_CHANGED, stored)
      }
      return stored
    }
  }
}
