// `SqliteDelegationTokenStore` (16 §4.8 row `DelegationTokenStore`; 05 §3.8; ADR-013 item 3): the
// 06 `DelegationToken` of each gated launch in `delegation_tokens` (09 §4.6). It never receives a
// credential, only its SHA-256 as lower-case hex.
//
// - `issue` inserts the row inside the caller's transaction (16 §2.2), its parent NULL when the
//   launch's dwarf has not arrived. The table refuses a second row for a launch (`launch_id` PK,
//   revoked rows included), a hash on `in-process`, a `ticket-file` or `protocol` without one and
//   a hash that is not 64 characters (migration 0002, owner amendment N (AMENDMENT-14, OQ-85),
//   2026-10-15); the statement's failure aborts the caller's command (16 §2.1).
// - `bindParent` sets a NULL parent once; the same dwarf again changes nothing, another dwarf is a
//   `HostInvariantError`, an unknown launch is a no-op.
// - `live` lists the unrevoked rows by launch id.
// - `byLaunch` reads the live row only, so a revoked token is never returned (16 §5.7).
// - `revoke` stamps the live row only, so a revoked row keeps its first `revoked_at`.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { DwarfId, Instant, LaunchId } from '../../../../kernel/domain/values'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { DelegationToken, DelegationTokenStore } from '../../ports/delegationStores'

const INSERT = `
  INSERT INTO delegation_tokens (launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at, revoked_at)
  VALUES (?, ?, ?, ?, ?, NULL)`

const LIVE = `
  SELECT launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at
  FROM delegation_tokens WHERE launch_id = ? AND revoked_at IS NULL`

const LIVE_ALL = `
  SELECT launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at
  FROM delegation_tokens WHERE revoked_at IS NULL ORDER BY launch_id`

const BIND = `
  UPDATE delegation_tokens SET parent_dwarf_id = ? WHERE launch_id = ? AND parent_dwarf_id IS NULL`

const PARENT_OF = `SELECT parent_dwarf_id FROM delegation_tokens WHERE launch_id = ?`

const REVOKE = `
  UPDATE delegation_tokens SET revoked_at = ? WHERE launch_id = ? AND revoked_at IS NULL`

export class SqliteDelegationTokenStore implements DelegationTokenStore {
  constructor(private readonly db: SqliteDatabase) {}

  issue(t: DelegationToken): void {
    this.db.run(INSERT, [
      t.launchId,
      t.parentDwarfId,
      t.mechanism,
      t.credentialHash ?? null,
      t.issuedAt
    ])
  }

  byLaunch(id: LaunchId): DelegationToken | null {
    const row = this.db.all(LIVE, [id])[0]
    return row === undefined ? null : toToken(row)
  }

  bindParent(id: LaunchId, parent: DwarfId): void {
    if (this.db.run(BIND, [parent, id]).changes > 0) return
    const row = this.db.all(PARENT_OF, [id])[0]
    if (row === undefined || row['parent_dwarf_id'] === parent) return
    throw new HostInvariantError('a delegation token is bound to its parent once')
  }

  live(): DelegationToken[] {
    return this.db.all(LIVE_ALL).map(toToken)
  }

  revoke(id: LaunchId, at: Instant): void {
    this.db.run(REVOKE, [at, id])
  }
}

function toToken(row: SqliteRow): DelegationToken {
  const hash = row['credential_hash']
  const parent = row['parent_dwarf_id']
  return {
    launchId: String(row['launch_id']) as LaunchId,
    parentDwarfId: typeof parent === 'string' ? (parent as DwarfId) : null,
    mechanism: row['mechanism'] as DelegationToken['mechanism'],
    ...(typeof hash === 'string' ? { credentialHash: hash } : {}),
    issuedAt: Number(row['issued_at'])
  }
}
