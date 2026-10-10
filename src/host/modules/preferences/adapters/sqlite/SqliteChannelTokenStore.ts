// `SqliteChannelTokenStore` (16 §4.12 row `ChannelTokenStore`; 05 §3.12; ADR-016 item 1): the
// per-channel token hashes in `channel_tokens` (09 §4.8). It never receives a token, only its
// SHA-256 as lower-case hex.
//
// - `issue` revokes the channel's active row and inserts the new hash, both inside the caller's
//   transaction (16 §2.2; 16 §7.3 Tx A, before the file I/O), so `channel_tokens_one_active` never
//   sees two live rows and a rollback leaves the previous token active. The table's CHECK refuses a
//   hash that is not 64 characters and its UNIQUE refuses a hash already stored; the statement's
//   failure aborts the caller's command (16 §2.1).
// - `active` reads the one live row of the channel; the hook ingress compares against it
//   (host/transport/auth/channelTokenCheck.ts).
// - `revoke` stamps the channel's live row only, so a revoked row keeps its first `revoked_at`.
// - `withdraw` (owner amendment M) deletes the active row of a failed write and reactivates the `prior` row that issue
//   revoked, refusing any other row (ADR-016: a revoked token never comes back by accident).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { Instant } from '../../../../kernel/domain/values'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { ChannelTokenStore, TokenChannel } from '../../ports/channelTokenStore'

export interface SqliteChannelTokenStoreDeps {
  db: SqliteDatabase
  ids: IdGenerator
}

const REVOKE = `
  UPDATE channel_tokens SET revoked_at = ? WHERE channel = ? AND revoked_at IS NULL`

const INSERT = `
  INSERT INTO channel_tokens (id, channel, token_sha256, created_at, revoked_at)
  VALUES (?, ?, ?, ?, NULL)`

// Owner amendment M: the active row of a hash, the row an issue at `created_at` revoked, and the two writes of
// `withdraw`. `issue` stamps the row it revokes with the new row's `created_at`, so the prior the caller names must
// carry that stamp; the caller read it with `active` in the same transaction as the issue, which is what tells it
// apart from a row a separate `revoke` stamped at the same instant.
const ACTIVE_ROW = `
  SELECT id, created_at FROM channel_tokens
  WHERE channel = ? AND token_sha256 = ? AND revoked_at IS NULL`

const REVOKED_BY = `
  SELECT id FROM channel_tokens WHERE channel = ? AND token_sha256 = ? AND revoked_at = ?`

const DELETE = `DELETE FROM channel_tokens WHERE id = ?`

const REACTIVATE = `UPDATE channel_tokens SET revoked_at = NULL WHERE id = ?`

const ACTIVE = `
  SELECT token_sha256 FROM channel_tokens WHERE channel = ? AND revoked_at IS NULL`

export class SqliteChannelTokenStore implements ChannelTokenStore {
  constructor(private readonly deps: SqliteChannelTokenStoreDeps) {}

  issue(channel: TokenChannel, hash: string, at: Instant): void {
    this.revoke(channel, at)
    this.deps.db.run(INSERT, [this.deps.ids.uuidv7(), channel, hash, at])
  }

  active(channel: TokenChannel): { hash: string } | null {
    const hash = this.deps.db.all(ACTIVE, [channel])[0]?.['token_sha256']
    return typeof hash === 'string' ? { hash } : null
  }

  withdraw(channel: TokenChannel, hash: string, prior: string | null, _at: Instant): void {
    const added = this.deps.db.all(ACTIVE_ROW, [channel, hash])[0]
    if (added === undefined) {
      throw new HostInvariantError('withdraw names a hash that is not the channel’s active token')
    }
    const revoked =
      prior === null
        ? undefined
        : this.deps.db.all(REVOKED_BY, [channel, prior, Number(added['created_at'])])[0]
    if (prior !== null && revoked === undefined) {
      throw new HostInvariantError('withdraw names a prior token that issue did not revoke')
    }
    this.deps.db.run(DELETE, [String(added['id'])])
    if (revoked !== undefined) this.deps.db.run(REACTIVATE, [String(revoked['id'])])
  }

  revoke(channel: TokenChannel, at: Instant): void {
    this.deps.db.run(REVOKE, [at, channel])
  }
}
