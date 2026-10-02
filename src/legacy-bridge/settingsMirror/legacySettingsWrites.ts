// The legacy store's write notifications (21 §3 `SettingsMirrorBridge`): today's settings handlers, composed through
// `LegacyRuntimeRoute`, report each save of a Host-read preference with `saved`, after the legacy store stored it; the
// bridge subscribes with `onWrite`. A half wires its handler's save to `saved` (the notifications half, ISSUE-116; the
// Jev half, ISSUE-194). It carries the key only: the value is read back from the legacy store, the source of truth.
import type { HostPreferenceKey } from '@dwarfai/contracts'
import type { LegacySettingsWrites } from './settingsMirrorBridge'

export interface LegacySettingsWriteHub extends LegacySettingsWrites {
  /** The legacy store saved `key`: every subscriber hears it. */
  saved(key: HostPreferenceKey): void
}

export function createLegacySettingsWriteHub(): LegacySettingsWriteHub {
  const listeners = new Set<(key: HostPreferenceKey) => void>()
  return {
    onWrite: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    saved: (key) => {
      for (const listener of [...listeners]) listener(key)
    }
  }
}
