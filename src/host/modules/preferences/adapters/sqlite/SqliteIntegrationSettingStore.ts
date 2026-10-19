// `SqliteIntegrationSettingStore` (16 §4.12): the `integration_settings` rows (09 §4.8), one per
// `IntegrationId`, seeded `off` by migration 1 (09 §4.9). `save` runs inside the caller's
// transaction (16 §2.2); the table's CHECKs refuse a consent origin on an `off` row, a missing one
// on an `on-*` row and `add-panel` for `claude-hooks`, and the failing statement aborts the
// caller's command (16 §2.1).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { IntegrationId, IntegrationState } from '../../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { ConsentOrigin } from '../../ports/externalConfigWriter'
import type {
  IntegrationSetting,
  IntegrationSettingStore
} from '../../ports/integrationSettingStore'

export interface SqliteIntegrationSettingStoreDeps {
  db: SqliteDatabase
}

const GET = `SELECT state, consent_origin, changed_at FROM integration_settings WHERE id = ?`

const SAVE = `
  UPDATE integration_settings SET state = ?, consent_origin = ?, changed_at = ? WHERE id = ?`

export class SqliteIntegrationSettingStore implements IntegrationSettingStore {
  constructor(private readonly deps: SqliteIntegrationSettingStoreDeps) {}

  get(id: IntegrationId): IntegrationSetting {
    const row = this.deps.db.all(GET, [id])[0]
    // Migration 1 seeds one row per integration in the transaction that creates the table.
    if (row === undefined) throw new HostInvariantError(`integration_settings has no row ${id}`)
    const origin = row['consent_origin']
    return {
      id,
      state: row['state'] as IntegrationState,
      ...(origin === null ? {} : { consentOrigin: origin as ConsentOrigin }),
      changedAt: Number(row['changed_at'])
    }
  }

  save(s: IntegrationSetting): void {
    const { changes } = this.deps.db.run(SAVE, [
      s.state,
      s.consentOrigin ?? null,
      s.changedAt,
      s.id
    ])
    if (changes !== 1) throw new HostInvariantError(`integration_settings has no row ${s.id}`)
  }
}
