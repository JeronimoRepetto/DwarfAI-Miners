// The DelegationTokenStore double (16 §4.8 `InMemoryDelegationTokenStore`). Never imported by
// production code (R14).
//
// It keeps the SQLite adapter's rules, held equal by the shared runDelegationTokenStoreContract:
// one row per launch, revoked ones included (`launch_id` PK); a 64-character credential hash on
// `ticket-file` and `protocol` and on no other mechanism (09 §4.6 CHECKs, migration 0002);
// `byLaunch` never returns a revoked token; `bindParent` sets a NULL parent once; `live` lists the
// unrevoked rows by launch id; `revoke` stamps a live row once. It has no transaction of its own: a test's transaction
// rolls it back with `snapshot` / `restore`.
import type { DwarfId, Instant, LaunchId } from '../../../../kernel/domain/values'
import type { DelegationToken, DelegationTokenStore } from '../delegationStores'

const HASH_LENGTH = 64
/** The relay entries, which authenticate with the credential file (AMENDMENT-14 A14-05). */
const RELAY_MECHANISMS: readonly DelegationToken['mechanism'][] = ['ticket-file', 'protocol']

export class InMemoryDelegationTokenStore implements DelegationTokenStore {
  private rows: DelegationToken[] = []

  issue(t: DelegationToken): void {
    if (RELAY_MECHANISMS.includes(t.mechanism) !== (t.credentialHash !== undefined)) {
      throw new Error('a credential hash is stored exactly for ticket-file and protocol (09 §4.6)')
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

  bindParent(id: LaunchId, parent: DwarfId): void {
    const row = this.rows.find((r) => r.launchId === id)
    if (row === undefined || row.parentDwarfId === parent) return
    if (row.parentDwarfId !== null) {
      throw new Error('a delegation token is bound to its parent once')
    }
    this.rows = this.rows.map((r) => (r === row ? { ...r, parentDwarfId: parent } : r))
  }

  live(): DelegationToken[] {
    return this.snapshot().filter((row) => row.revokedAt === undefined)
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
