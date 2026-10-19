// layer: L3
// L3 (17 §1.3): the CursorStore conformance suite over a copy of the run's template database
// (schema v1), so every write meets the real CHECKs and the `source_cursors_never_regress`
// trigger (09 §4.2).
import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runCursorStoreContract } from '../testing/cursorStore.contract'
import { SqliteCursorStore } from './SqliteCursorStore'

describe('SqliteCursorStore', () => {
  runCursorStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    let now = 1_790_000_000_000
    return {
      store: new SqliteCursorStore({ db, scope: runner, clock: { now: () => (now += 1) } }),
      inTransaction: (work) => runner.inTransaction(work)
    }
  })
})
