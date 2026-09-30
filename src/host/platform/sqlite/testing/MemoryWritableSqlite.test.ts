import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../../kernel/domain/errors'
import { runTransactionRunnerContract } from '../../../kernel/testing/transactionRunner.contract'
import { SqliteTransactionRunner } from '../SqliteTransactionRunner'
import { MemoryWritableSqlite } from './MemoryWritableSqlite'
import { otherWriterCanTakeWriteLock } from './otherWriter'

// The TransactionRunner double is the real runner over memory SQLite (16 §3: no fake runner).
describe('SqliteTransactionRunner over MemoryWritableSqlite', () => {
  runTransactionRunnerContract(() => {
    const db = new MemoryWritableSqlite()
    const other = new DatabaseSync(db.location)
    return {
      db,
      runner: new SqliteTransactionRunner(db),
      otherWriterCanTakeWriteLock: () => otherWriterCanTakeWriteLock(other),
      dispose: () => {
        other.close()
        db.close()
      }
    }
  })
})

describe('MemoryWritableSqlite', () => {
  const opened: MemoryWritableSqlite[] = []

  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
  })

  it('[FM-104] failWith makes every statement on the writer throw that SQLITE_* error until it is cleared', () => {
    const db = new MemoryWritableSqlite()
    opened.push(db)
    db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY) STRICT')
    const runner = new SqliteTransactionRunner(db)

    db.failWith('SQLITE_FULL')
    let thrown: unknown
    try {
      runner.inTransaction(() => db.run('INSERT INTO notes (id) VALUES (?)', ['n1']))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SqliteInfrastructureError)
    expect((thrown as SqliteInfrastructureError).code).toBe('SQLITE_FULL')
    expect(() => db.all('SELECT id FROM notes')).toThrow(SqliteInfrastructureError)

    db.failWith(null)
    expect(runner.isInTransaction()).toBe(false)
    expect(db.all('SELECT id FROM notes')).toEqual([])
    runner.inTransaction(() => db.run('INSERT INTO notes (id) VALUES (?)', ['n2']))
    expect(db.all('SELECT id FROM notes')).toEqual([{ id: 'n2' }])
  })

  it('[ADR-005] two instances never share a database, and a reader sees only committed rows of its own', () => {
    const first = new MemoryWritableSqlite()
    const second = new MemoryWritableSqlite()
    opened.push(first, second)
    first.exec('CREATE TABLE notes (id TEXT PRIMARY KEY) STRICT')
    first.run('INSERT INTO notes (id) VALUES (?)', ['n1'])

    const reader = first.openReader()
    try {
      expect(reader.all('SELECT id FROM notes')).toEqual([{ id: 'n1' }])
      expect(reader.all('PRAGMA query_only')).toEqual([{ query_only: 1 }])
    } finally {
      reader.close()
    }
    expect(second.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
  })
})
