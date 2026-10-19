// The PreferencesStore double (16 §4.12 `InMemoryPreferencesStore`). Never imported by production
// code (R14).
//
// It keeps the SQLite adapter's rules: one row, starting at the migration-1 seed (09 §4.9); a
// default model or effort without a default provider refused on save (09 §4.8 CHECK); and
// `openCodePermissionsOn` derived from an OpenCode integration state it holds
// (`setOpenCodeIntegration`), never from what was saved (06 §14.2). A ports folder imports types
// only (R2), so the seed and the rule are restated here and held equal to the domain's by the
// shared runPreferencesStoreContract. It has no transaction of its own: a test's transaction rolls
// it back with `snapshot` / `restore`.
import type { HostPreferences } from '../../domain/hostPreferences'
import type { PreferencesStore } from '../preferencesStore'

type StoredPreferences = Omit<HostPreferences, 'openCodePermissionsOn'>

export class InMemoryPreferencesStore implements PreferencesStore {
  private row: StoredPreferences = {
    subagentDelegationOn: false,
    routingProfile: 'balanced',
    systemNotificationsOn: true
  }
  private openCodeIntegration: 'off' | 'on-unverified' | 'on-verified' = 'off'

  load(): HostPreferences {
    return { ...this.row, openCodePermissionsOn: this.openCodeIntegration !== 'off' }
  }

  save(p: HostPreferences): void {
    if (p.defaultProvider === undefined && (p.defaultModel ?? p.defaultEffort) !== undefined) {
      throw new Error('a default model or effort needs a default provider (09 §4.8)')
    }
    this.row = stored(p)
  }

  /** The OpenCode integration's state, which `openCodePermissionsOn` is derived from (06 §14.2). */
  setOpenCodeIntegration(state: 'off' | 'on-unverified' | 'on-verified'): void {
    this.openCodeIntegration = state
  }

  /** The stored row, for a test transaction to restore on rollback. */
  snapshot(): StoredPreferences {
    return { ...this.row }
  }

  restore(snapshot: StoredPreferences): void {
    this.row = { ...snapshot }
  }
}

/** The stored part of `p`: every key but the derived one, the absent optional keys left out. */
function stored(p: HostPreferences): StoredPreferences {
  const row: StoredPreferences = {
    subagentDelegationOn: p.subagentDelegationOn,
    routingProfile: p.routingProfile,
    systemNotificationsOn: p.systemNotificationsOn
  }
  if (p.defaultProvider !== undefined) row.defaultProvider = p.defaultProvider
  if (p.defaultModel !== undefined) row.defaultModel = p.defaultModel
  if (p.defaultEffort !== undefined) row.defaultEffort = p.defaultEffort
  return row
}
