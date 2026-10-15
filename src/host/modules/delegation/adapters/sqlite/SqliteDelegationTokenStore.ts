// `SqliteDelegationTokenStore` (16 §4.8 row `DelegationTokenStore`; 05 §3.8; ADR-013 item 3): the
// 06 `DelegationToken` of each gated launch in `delegation_tokens` (09 §4.6). It never receives a
// credential, only its SHA-256 as lower-case hex.
//
// - `issue` inserts the row inside the caller's transaction (16 §2.2). The table refuses a second
//   row for a launch (`launch_id` PK, revoked rows included), a hash on any mechanism but
//   `ticket-file`, a `ticket-file` without one and a hash that is not 64 characters; the
//   statement's failure aborts the caller's command (16 §2.1).
// - `byLaunch` reads the live row only, so a revoked token is never returned (16 §5.7).
// - `revoke` stamps the live row only, so a revoked row keeps its first `revoked_at`.
import type { DwarfId, Instant, LaunchId } from '../../../../kernel/domain/values'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { DelegationToken, DelegationTokenStore } from '../../ports/delegationStores'

const INSERT = `
  INSERT INTO delegation_tokens (launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at, revoked_at)
  VALUES (?, ?, ?, ?, ?, NULL)`

const LIVE = `
  SELECT launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at
  FROM delegation_tokens WHERE launch_id = ? AND revoked_at IS NULL`

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

  revoke(id: LaunchId, at: Instant): void {
    this.db.run(REVOKE, [at, id])
  }
}

function toToken(row: SqliteRow): DelegationToken {
  const hash = row['credential_hash']
  return {
    launchId: String(row['launch_id']) as LaunchId,
    parentDwarfId: String(row['parent_dwarf_id']) as DwarfId,
    mechanism: row['mechanism'] as DelegationToken['mechanism'],
    ...(typeof hash === 'string' ? { credentialHash: hash } : {}),
    issuedAt: Number(row['issued_at'])
  }
}
