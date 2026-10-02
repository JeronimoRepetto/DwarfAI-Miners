// Driven port (05 §3.12, 16 §4.12): the singleton `host_preferences` row, read and written inside
// the caller's transaction. `load` derives `openCodePermissionsOn` from the OpenCode integration;
// `save` stores the writable keys only and refuses a row that breaks the provider rule (09 §4.8).
import type { HostPreferences } from '../domain/hostPreferences'

export interface PreferencesStore {
  load(): HostPreferences
  save(p: HostPreferences): void
}
