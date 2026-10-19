// `SqliteConfigWriteLedger`: the `config_writes` rows (09 §4.8) of the config writer engine's
// Tx A and Tx B (16 §7.3), inside the caller's transaction (16 §2.2). The partial unique index
// `config_writes_one_active` keeps at most one live write per target, and a failing statement
// aborts the caller's command (16 §2.1). Reverted rows are kept as the proof of what was undone
// (09 §7.2); their 90-day cleanup belongs to the retention pass, not here.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { Instant } from '../../../../kernel/domain/values'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { ConfigTarget, ConsentOrigin } from '../../ports/externalConfigWriter'
import type { ConfigWriteLedger, ConfigWriteRow } from '../external-config/configWriteLedger'

export interface SqliteConfigWriteLedgerDeps {
  db: SqliteDatabase
}

const COLUMNS = `id, kind, target_path, owned_marker, backup_path, consent_origin, written_at,
  verified_at, reverted_at`

const ACTIVE = `SELECT ${COLUMNS} FROM config_writes
  WHERE kind = ? AND target_path = ? AND reverted_at IS NULL`

const UNVERIFIED = `SELECT ${COLUMNS} FROM config_writes
  WHERE reverted_at IS NULL AND verified_at IS NULL ORDER BY written_at, id`

const RECORD = `INSERT INTO config_writes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, target_path = excluded.target_path,
    owned_marker = excluded.owned_marker, backup_path = excluded.backup_path,
    consent_origin = excluded.consent_origin, written_at = excluded.written_at,
    verified_at = excluded.verified_at, reverted_at = excluded.reverted_at`

const nullableInstant = (value: unknown): Instant | null => (value === null ? null : Number(value))

function rowOf(row: SqliteRow): ConfigWriteRow {
  return {
    id: String(row['id']),
    kind: row['kind'] as ConfigTarget,
    targetPath: String(row['target_path']),
    ownedMarker: String(row['owned_marker']),
    backupPath: row['backup_path'] === null ? null : String(row['backup_path']),
    consentOrigin: row['consent_origin'] as ConsentOrigin,
    writtenAt: Number(row['written_at']),
    verifiedAt: nullableInstant(row['verified_at']),
    revertedAt: nullableInstant(row['reverted_at'])
  }
}

export class SqliteConfigWriteLedger implements ConfigWriteLedger {
  constructor(private readonly deps: SqliteConfigWriteLedgerDeps) {}

  active(kind: ConfigTarget, targetPath: string): ConfigWriteRow | null {
    const row = this.deps.db.all(ACTIVE, [kind, targetPath])[0]
    return row === undefined ? null : rowOf(row)
  }

  unverified(): ConfigWriteRow[] {
    return this.deps.db.all(UNVERIFIED).map(rowOf)
  }

  record(row: ConfigWriteRow): void {
    this.deps.db.run(RECORD, [
      row.id,
      row.kind,
      row.targetPath,
      row.ownedMarker,
      row.backupPath,
      row.consentOrigin,
      row.writtenAt,
      row.verifiedAt,
      row.revertedAt
    ])
  }

  markVerified(id: string, at: Instant, backupPath: string | null): void {
    this.changeOne(`UPDATE config_writes SET verified_at = ?, backup_path = ? WHERE id = ?`, [
      at,
      backupPath,
      id
    ])
  }

  markReverted(id: string, at: Instant): void {
    this.changeOne(`UPDATE config_writes SET reverted_at = ? WHERE id = ?`, [at, id])
  }

  remove(id: string): void {
    this.changeOne(`DELETE FROM config_writes WHERE id = ?`, [id])
  }

  private changeOne(sql: string, params: ReadonlyArray<string | number | null>): void {
    const { changes } = this.deps.db.run(sql, params)
    if (changes !== 1)
      throw new HostInvariantError(`config_writes has no row ${String(params.at(-1))}`)
  }
}
