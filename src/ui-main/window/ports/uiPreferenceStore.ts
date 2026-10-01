// UiPreferenceStore: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14): one JSON file per
// store, written atomically (temp file + rename, 09 §1) by UI main alone; a corrupt or non-conforming file loads that
// store's defaults and is logged (FM-053). Adapter `JsonUiPreferenceStore`, double `InMemoryUiPreferenceStore`
// (16 §4.14 table).
//
// Owner-approved editorial amendment (2026-10-01, ISSUE-048): 16 §4.14 types this port over `UiPreferenceKey`, the keys
// of 14 §3.9 `UiPreferencesMap` (the NEW A-N20 map, ISSUE-060), while its adapter row assigns it the six KEEP stores of
// `shell/*Preference.ts` (audio, typography, launch view, panel edge, pin, shortcut), none of which is a
// `UiPreferencesMap` key. The amendment states the key space = the six KEEP stores ∪ the `UiPreferencesMap` keys,
// with the members and their semantics unchanged (`load<K>(k): Map[K]`, `save<K>(k, v): void`, synchronous). The six
// KEEP stores below are named by ADR-024 item 1; the `UiPreferencesMap` keys join when ISSUE-060 brings that map. Each value type is the seam A shape of its row
// (14 §2.1), taken from the channel registry, never restated.
import type { z } from 'zod'
import type { CHANNELS, LogRecord } from '@dwarfai/contracts'

/** A-06/A-07 `AudioPreferences` (music at startup, the three volumes, `notificationSounds`). */
export type AudioPreferences = z.infer<(typeof CHANNELS)['audio:preferences:get']['response']>
/** A-45/A-46/A-P6 `TypographyPreferences` (the font style and the face of each type role). */
export type TypographyPreferences = z.infer<
  (typeof CHANNELS)['typography:preferences:get']['response']
>
/** A-56/A-57 `LaunchView` (the page and the mine the app opens on). */
export type LaunchView = z.infer<(typeof CHANNELS)['launch-view:get']['response']>
/** The docking edge of the Panel (`PanelLayout.edge`, A-08/A-09; ADR-024 item 1 `dockSide`). */
export type DockSide = z.infer<(typeof CHANNELS)['panel:layout:get']['response']>['edge']

/** The persisted UI-main stores of ADR-024 item 1 that seam A keeps from today (14 §2.1 KEEP rows). */
export interface UiPreferenceStoreMap {
  audio: AudioPreferences
  typography: TypographyPreferences
  launchView: LaunchView
  /** ISSUE-047 reads and writes it (A-08/A-09). */
  dockSide: DockSide
  /** ISSUE-047 reads and writes it (A-03/A-04). */
  alwaysOnTop: boolean
  /** The recorded global shortcut, canonical; `null` = none recorded, so the platform default applies (ISSUE-049). */
  shortcut: string | null
}

export type UiPreferenceStoreKey = keyof UiPreferenceStoreMap

/**
 * The one log record a store writes when it cannot use a file (19 §9.6): `uiprefs.corrupt` when a store fell back to
 * its defaults, `uiprefs.write-failed` when a write failed. `msg` is the store name; never a value, never a path.
 */
export type UiPreferenceLogRecord = Required<
  Pick<LogRecord, 'level' | 'event' | 'subsystem' | 'msg'>
> &
  Pick<LogRecord, 'errCode'> & {
    level: 'warn'
    event: 'uiprefs.corrupt' | 'uiprefs.write-failed'
    subsystem: 'window'
    msg: UiPreferenceStoreKey
  }

export interface UiPreferenceStore {
  /** The stored value, or the store's defaults when nothing conforming is stored (logged when a file was unusable). */
  load<K extends UiPreferenceStoreKey>(k: K): UiPreferenceStoreMap[K]
  /** Replaces the stored value atomically; throws when the write failed, leaving the previous value in place. */
  save<K extends UiPreferenceStoreKey>(k: K, v: UiPreferenceStoreMap[K]): void
}
