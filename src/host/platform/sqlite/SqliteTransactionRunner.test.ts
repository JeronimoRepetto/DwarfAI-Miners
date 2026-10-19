import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe } from 'vitest'
import { runTransactionRunnerContract } from '../../kernel/testing/transactionRunner.contract'
import { NodeSqliteDatabase } from './NodeSqliteDatabase'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { otherWriterCanTakeWriteLock } from './testing/otherWriter'

// L3 over a real database file (17 §1.3): a fresh temp dir per test, removed afterwards.
describe('SqliteTransactionRunner over a database file', () => {
  runTransactionRunnerContract(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwarfai-sqlite-runner-'))
    const path = join(dir, 'host.db')
    const db = NodeSqliteDatabase.open(path)
    // The competing writer must not wait: it only asks whether the lock is free right now.
    const other = new DatabaseSync(path, { timeout: 0 })
    return {
      db,
      runner: new SqliteTransactionRunner(db),
      otherWriterCanTakeWriteLock: () => otherWriterCanTakeWriteLock(other),
      dispose: async () => {
        other.close()
        db.close()
        await rm(dir, { recursive: true, force: true })
      }
    }
  })
})
