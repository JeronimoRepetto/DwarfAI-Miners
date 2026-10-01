import { describe } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { LifecycleFactType } from '../../kernel/ports/lifecycleFactLog'
import { runLifecycleFactLogContract } from '../../kernel/testing/lifecycleFactLog.contract'
import { initialMigration } from './migrations/0001-initial'
import { SqliteLifecycleFactLog } from './SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { MemoryWritableSqlite } from './testing/MemoryWritableSqlite'

// L3 (17 §1.3): the contract over a real SQLite at schema v1 (migration 1 applied), with one mine
// and two dwarfs seeded, so the fact rows meet the real CHECKs, UNIQUE keys and foreign key.

const T0 = 1_750_000_000_000
const MINE = '00000000-0000-7000-8000-0000000000f1'
const DWARFS = [
  '00000000-0000-7000-8000-0000000000d1',
  '00000000-0000-7000-8000-0000000000d2'
] as const

describe('SqliteLifecycleFactLog', () => {
  runLifecycleFactLogContract(() => {
    const db = new MemoryWritableSqlite()
    const runner = new SqliteTransactionRunner(db)
    const clock = new FakeClock(T0)
    const ids = new SequenceIdGenerator()
    runner.inTransaction(() => {
      initialMigration({ clock, ids }).up(db)
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [MINE, '/work/mine-one', 'mine-one', 'mine-one', T0, T0]
      )
      DWARFS.forEach((id, n) => {
        db.run(
          `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
             process_state, turn_state, arrived_at, last_activity_at)
           VALUES (?, ?, 'claude', ?, ?, 'foreman', 'running', 'none-yet', ?, ?)`,
          [id, MINE, `session-${n}`, `Dwarf ${n}`, T0, T0]
        )
      })
    })
    return {
      log: new SqliteLifecycleFactLog({ db, scope: runner, ids, clock }),
      dwarfIds: DWARFS,
      inTransaction: (work) => runner.inTransaction(work),
      facts: () =>
        db
          .all('SELECT type, dwarf_id, source_key FROM dwarf_lifecycle_facts ORDER BY rowid')
          .map((row) => ({
            type: row['type'] as LifecycleFactType,
            dwarfId: String(row['dwarf_id']),
            sourceKey: row['source_key'] === null ? null : String(row['source_key'])
          })),
      dispose: () => db.close()
    }
  })
})
