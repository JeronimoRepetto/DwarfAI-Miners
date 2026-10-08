import { describe } from 'vitest'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import type { TokenChannel } from '../../ports/channelTokenStore'
import { runChannelTokenStoreContract } from '../../testing/channelTokenStore.contract'
import { SqliteChannelTokenStore } from './SqliteChannelTokenStore'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), so every row meets the real CHECKs, the UNIQUE hash and `channel_tokens_one_active`
// of 09 §4.8.
describe('SqliteChannelTokenStore', () => {
  runChannelTokenStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const all = () => db.all('SELECT * FROM channel_tokens ORDER BY created_at, id')
    return {
      store: new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() }),
      inTransaction: (work) => runner.inTransaction(work),
      rows: () =>
        all().map((row) => ({
          channel: row['channel'] as TokenChannel,
          hash: String(row['token_sha256']),
          createdAt: Number(row['created_at']),
          revokedAt: row['revoked_at'] === null ? null : Number(row['revoked_at'])
        })),
      storedText: () => JSON.stringify(all()),
      dispose: () => undefined
    }
  })
})
