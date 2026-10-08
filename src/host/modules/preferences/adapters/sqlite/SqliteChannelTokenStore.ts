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

  revoke(channel: TokenChannel, at: Instant): void {
    this.deps.db.run(REVOKE, [at, channel])
  }
}
