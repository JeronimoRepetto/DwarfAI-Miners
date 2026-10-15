import { describe } from 'vitest'
import type { DwarfId, Instant, LaunchId } from '../../../../kernel/domain/values'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import type { DelegationToken } from '../../ports/delegationStores'
import {
  runDelegationTokenStoreContract,
  TOKEN_LAUNCH,
  TOKEN_OTHER_PARENT,
  TOKEN_PARENT,
  TOKEN_SPARE_LAUNCH
} from '../../testing/delegationTokenStore.contract'
import { seedDelegationRows } from '../../testing/seedDelegationRows'
import { SqliteDelegationTokenStore } from './SqliteDelegationTokenStore'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), so every row meets the real `launch_id` PK, the 09 §4.6 CHECKs and the foreign keys.
describe('SqliteDelegationTokenStore', () => {
  runDelegationTokenStoreContract(() => {
    const { db } = openTemplateCopy()
    seedDelegationRows(db, {
      dwarfs: [TOKEN_PARENT, TOKEN_OTHER_PARENT],
      launches: [TOKEN_LAUNCH, TOKEN_SPARE_LAUNCH]
    })
    const runner = new SqliteTransactionRunner(db)
    const all = () => db.all('SELECT * FROM delegation_tokens ORDER BY launch_id')
    return {
      store: new SqliteDelegationTokenStore(db),
      inTransaction: (work) => runner.inTransaction(work),
      rows: () =>
        all().map((row): DelegationToken => ({
          launchId: String(row['launch_id']) as LaunchId,
          parentDwarfId: String(row['parent_dwarf_id']) as DwarfId,
          mechanism: row['mechanism'] as DelegationToken['mechanism'],
          ...(row['credential_hash'] === null
            ? {}
            : { credentialHash: String(row['credential_hash']) }),
          issuedAt: Number(row['issued_at']) as Instant,
          ...(row['revoked_at'] === null ? {} : { revokedAt: Number(row['revoked_at']) })
        })),
      storedText: () => JSON.stringify(all()),
      dispose: () => undefined
    }
  })
})
