// The ChannelTokenStore double (16 §4.12 `InMemory*`). Never imported by production code (R14).
//
// It keeps the SQLite adapter's rules, held equal by the shared runChannelTokenStoreContract: a
// hash of 64 characters, unique across every row, revoked ones included (09 §4.8 CHECK and UNIQUE);
// one active row per channel, so `issue` revokes the channel's previous row first; `revoke` stamps
// only the active row. It has no transaction of its own: a test's transaction rolls it back with
// `snapshot` / `restore`.
import type { Instant } from '../../../../kernel/domain/values'
import type { ChannelTokenStore, TokenChannel } from '../channelTokenStore'

interface Row {
  channel: TokenChannel
  hash: string
  createdAt: Instant
  revokedAt: Instant | null
}

const HASH_LENGTH = 64

export class InMemoryChannelTokenStore implements ChannelTokenStore {
  private rows: Row[] = []

  issue(channel: TokenChannel, hash: string, at: Instant): void {
    if (hash.length !== HASH_LENGTH) throw new Error('a token hash is 64 characters (09 §4.8)')
    if (this.rows.some((row) => row.hash === hash)) {
      throw new Error('a token hash is stored once (09 §4.8)')
    }
    this.revoke(channel, at)
    this.rows.push({ channel, hash, createdAt: at, revokedAt: null })
  }

  active(channel: TokenChannel): { hash: string } | null {
    const row = this.rows.find((r) => r.channel === channel && r.revokedAt === null)
    return row === undefined ? null : { hash: row.hash }
  }

  /**
   * Owner amendment M: the same refusals as the SQLite adapter, held equal by the contract; a plain `Error` here,
   * as the double's other refusals, since a port folder imports types only (R2).
   */
  withdraw(channel: TokenChannel, hash: string, prior: string | null, _at: Instant): void {
    const added = this.rows.find(
      (row) => row.channel === channel && row.hash === hash && row.revokedAt === null
    )
    if (added === undefined) {
      throw new Error('withdraw names a hash that is not the channel’s active token')
    }
    const revoked =
      prior === null
        ? undefined
        : this.rows.find(
            (row) =>
              row.channel === channel && row.hash === prior && row.revokedAt === added.createdAt
          )
    if (prior !== null && revoked === undefined) {
      throw new Error('withdraw names a prior token that issue did not revoke')
    }
    this.rows = this.rows
      .filter((row) => row !== added)
      .map((row) => (row === revoked ? { ...row, revokedAt: null } : row))
  }

  revoke(channel: TokenChannel, at: Instant): void {
    this.rows = this.rows.map((row) =>
      row.channel === channel && row.revokedAt === null ? { ...row, revokedAt: at } : row
    )
  }

  /** Every row, oldest first, for a test transaction to restore on rollback. */
  snapshot(): Row[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(rows: Row[]): void {
    this.rows = rows.map((row) => ({ ...row }))
  }
}
