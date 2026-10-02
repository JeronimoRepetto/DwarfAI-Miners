import { describe } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runDwarfRepositoryContract } from '../testing/dwarfRepository.contract'
import { SqliteDwarfRepository } from './SqliteDwarfRepository'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), with two mines seeded, so every row meets the real CHECKs, the UNIQUE provider
// identity and the foreign keys of `dwarfs` (09 §4.2).
const T0 = 1_790_000_000_000
const MINES = [
  '00000000-0000-7000-8000-0000000000f1' as MineId,
  '00000000-0000-7000-8000-0000000000f2' as MineId
] as const

describe('SqliteDwarfRepository', () => {
  runDwarfRepositoryContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    runner.inTransaction(() => {
      MINES.forEach((id, n) => {
        db.run(
          `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [id, `/work/mine-${n}`, `mine-${n}`, `mine-${n}`, T0, T0]
        )
      })
    })
    return {
      repository: new SqliteDwarfRepository({ db, scope: runner }),
      mineIds: MINES,
      inTransaction: (work) => runner.inTransaction(work),
      dispose: () => undefined
    }
  })
})
