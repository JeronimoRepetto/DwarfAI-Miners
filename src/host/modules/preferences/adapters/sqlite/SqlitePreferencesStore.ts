// `SqlitePreferencesStore` (16 §4.12; 05 §3.12): the `host_preferences` singleton row (09 §4.8),
// seeded by migration 1 (09 §4.9). It replaces the legacy per-file stores
// (`notifications/notificationPreference.ts`, `shell/jevPreferences.ts`) for the Host-read
// preferences; those stay legacy until cut 4a.
//
// - `load` reads the one row and derives `openCodePermissionsOn` from the `opencode-permissions`
//   integration (`state ≠ 'off'`, 06 §14.2; 09 D-06): it is never stored here.
// - `save` writes the writable columns and `updated_at` inside the caller's transaction (16 §2.2);
//   the table's CHECK refuses a default model or effort without a default provider (09 §4.8), and
//   the statement's failure aborts the caller's command (16 §2.1).
import type { Clock } from '../../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { HostPreferences, JevRoutingProfile } from '../../domain/hostPreferences'
import type { PreferencesStore } from '../../ports/preferencesStore'

export interface SqlitePreferencesStoreDeps {
  db: SqliteDatabase
  clock: Clock
}

const LOAD = `
  SELECT p.subagent_delegation_on, p.routing_profile, p.default_provider, p.default_model,
         p.default_effort, p.system_notifications_on,
         coalesce((SELECT i.state <> 'off' FROM integration_settings i
                   WHERE i.id = 'opencode-permissions'), 0) AS open_code_permissions_on
  FROM host_preferences p
  WHERE p.id = 1`

const SAVE = `
  UPDATE host_preferences
  SET subagent_delegation_on = ?, routing_profile = ?, default_provider = ?, default_model = ?,
      default_effort = ?, system_notifications_on = ?, updated_at = ?
  WHERE id = 1`

export class SqlitePreferencesStore implements PreferencesStore {
  constructor(private readonly deps: SqlitePreferencesStoreDeps) {}

  load(): HostPreferences {
    const row = this.deps.db.all(LOAD)[0]
    // Migration 1 seeds the row in the transaction that creates the table (09 §4.9).
    if (row === undefined) throw new Error('the host_preferences row is missing')
    return fromRow(row)
  }

  save(p: HostPreferences): void {
    this.deps.db.run(SAVE, [
      p.subagentDelegationOn ? 1 : 0,
      p.routingProfile,
      p.defaultProvider ?? null,
      p.defaultModel ?? null,
      p.defaultEffort ?? null,
      p.systemNotificationsOn ? 1 : 0,
      this.deps.clock.now()
    ])
  }
}

function fromRow(row: SqliteRow): HostPreferences {
  const preferences: HostPreferences = {
    subagentDelegationOn: row['subagent_delegation_on'] === 1,
    routingProfile: row['routing_profile'] as JevRoutingProfile,
    systemNotificationsOn: row['system_notifications_on'] === 1,
    openCodePermissionsOn: row['open_code_permissions_on'] === 1
  }
  const provider = optionalText(row['default_provider'])
  const model = optionalText(row['default_model'])
  const effort = optionalText(row['default_effort'])
  if (provider !== undefined) preferences.defaultProvider = provider
  if (model !== undefined) preferences.defaultModel = model
  if (effort !== undefined) preferences.defaultEffort = effort
  return preferences
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
