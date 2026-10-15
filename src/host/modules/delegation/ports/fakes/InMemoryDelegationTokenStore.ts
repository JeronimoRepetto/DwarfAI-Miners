// The DelegationTokenStore double (16 §4.8 `InMemoryDelegationTokenStore`). Never imported by
// production code (R14).
//
// It keeps the SQLite adapter's rules, held equal by the shared runDelegationTokenStoreContract:
// one row per launch, revoked ones included (`launch_id` PK); a 64-character credential hash on
// `ticket-file` and on no other mechanism (09 §4.6 CHECKs); `byLaunch` never returns a revoked
// token; `revoke` stamps a live row once. It has no transaction of its own: a test's transaction
// rolls it back with `snapshot` / `restore`.
import type { Instant, LaunchId } from '../../../../kernel/domain/values'
import type { DelegationToken, DelegationTokenStore } from '../delegationStores'

const HASH_LENGTH = 64

export class InMemoryDelegationTokenStore implements DelegationTokenStore {
  private rows: DelegationToken[] = []

  issue(t: DelegationToken): void {
    if ((t.mechanism === 'ticket-file') !== (t.credentialHash !== undefined)) {
      throw new Error('a credential hash is stored exactly for ticket-file (09 §4.6)')
    }
    if (t.credentialHash !== undefined && t.credentialHash.length !== HASH_LENGTH) {
      throw new Error('a credential hash is 64 characters (09 §4.6)')
    }
    if (this.rows.some((row) => row.launchId === t.launchId)) {
      throw new Error('one delegation token per launch (09 §4.6 launch_id PK)')
    }
    this.rows.push({ ...t })
  }

  byLaunch(id: LaunchId): DelegationToken | null {
    const row = this.rows.find((r) => r.launchId === id && r.revokedAt === undefined)
    return row === undefined ? null : { ...row }
  }

  revoke(id: LaunchId, at: Instant): void {
    this.rows = this.rows.map((row) =>
      row.launchId === id && row.revokedAt === undefined ? { ...row, revokedAt: at } : row
    )
  }

  /** Every row by launch id, for a test transaction to restore on rollback. */
  snapshot(): DelegationToken[] {
    return this.rows
      .map((row) => ({ ...row }))
      .sort((a, b) => (a.launchId < b.launchId ? -1 : a.launchId > b.launchId ? 1 : 0))
  }

  restore(rows: DelegationToken[]): void {
    this.rows = rows.map((row) => ({ ...row }))
  }
}
