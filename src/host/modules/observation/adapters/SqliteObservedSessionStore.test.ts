// layer: L3
// L3 (17 §1.3): the ObservedSessionStore conformance suite over a copy of the run's template
// database (schema v1), so every row meets the real foreign keys of `observed_sessions` (to
// `dwarfs`) and `observed_session_streams` (to `source_cursors`) (09 §4.2). The dwarfs, their
// mines and the two streams are seeded as crew and the cursor store would write them.
import { describe } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runObservedSessionStoreContract } from '../testing/observedSessionStore.contract'
import { SqliteObservedSessionStore } from './SqliteObservedSessionStore'

const T0 = 1_790_000_000_000

describe('SqliteObservedSessionStore', () => {
  runObservedSessionStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    runner.inTransaction(() => {
      for (const stream of ['simulated:a', 'simulated:b']) {
        db.run(
          `INSERT INTO source_cursors (stream_id, adapter_id, kind, value, updated_at)
           VALUES (?, 'simulated', 'watermark', 0, ?)`,
          [stream, T0]
        )
      }
    })
    let n = 0
    return {
      store: new SqliteObservedSessionStore({ db, scope: runner }),
      inTransaction: (work) => runner.inTransaction(work),
      bindDwarf: (identity, folder, at) => {
        n += 1
        const mineId =
          `00000000-0000-7000-8000-0000000070${n.toString(16).padStart(2, '0')}` as MineId
        const dwarfId =
          `00000000-0000-7000-8000-0000000071${n.toString(16).padStart(2, '0')}` as DwarfId
        runner.inTransaction(() => {
          db.run(
            `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [mineId, folder, `mine-${n}`, `mine-${n}`, at, at]
          )
          db.run(
            `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, provider_agent_id,
               base_name, rank, process_state, turn_state, arrived_at, last_activity_at)
             VALUES (?, ?, ?, ?, ?, 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
            [
              dwarfId,
              mineId,
              identity.providerId,
              identity.providerSessionId,
              identity.providerAgentId ?? '',
              at,
              at
            ]
          )
        })
        return dwarfId
      },
      departDwarf: (dwarfId, at) => {
        runner.inTransaction(() =>
          db.run(
            `UPDATE dwarfs SET departed_at = ?, departure_cause = 'closed-elsewhere',
               process_state = 'closed', presence = 'walking-out' WHERE id = ?`,
            [at, dwarfId]
          )
        )
      },
      rowCount: () => Number(db.all('SELECT count(*) AS n FROM observed_sessions')[0]?.['n'])
    }
  })
})
