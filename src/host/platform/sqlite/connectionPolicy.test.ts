import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import type { SqliteDatabase, SqliteReader } from '../../kernel/ports/sqliteDatabase'
import { ConnectionPolicyError, applyConnectionPolicy } from './connectionPolicy'
import { NodeSqliteDatabase } from './NodeSqliteDatabase'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'

// L5 (17 §1): the 09 §8.1 connection policy on real database files, one temp dir per test.

function pragma(connection: Pick<SqliteReader, 'all'>, name: string): unknown {
  const [row] = connection.all(`PRAGMA ${name}`)
  return row === undefined ? undefined : Object.values(row)[0]
}

function policyOf(connection: Pick<SqliteReader, 'all'>): Record<string, unknown> {
  return {
    foreign_keys: pragma(connection, 'foreign_keys'),
    journal_mode: pragma(connection, 'journal_mode'),
    synchronous: pragma(connection, 'synchronous'),
    busy_timeout: pragma(connection, 'busy_timeout'),
    secure_delete: pragma(connection, 'secure_delete'),
    trusted_schema: pragma(connection, 'trusted_schema')
  }
}

const POLICY = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 1,
  busy_timeout: 5000,
  secure_delete: 2,
  trusted_schema: 0
}

describe('SQLite connection policy', () => {
  let dir: string
  const toClose: { close(): void }[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-sqlite-policy-'))
  })

  afterEach(async () => {
    for (const connection of toClose.splice(0).reverse()) connection.close()
    await rm(dir, { recursive: true, force: true })
  })

  function openWriter(name = 'host.db'): SqliteDatabase {
    const db = NodeSqliteDatabase.open(join(dir, name))
    toClose.push(db)
    return db
  }

  function openReader(db: SqliteDatabase): SqliteReader {
    const reader = db.openReader()
    toClose.push(reader)
    return reader
  }

  it('[ADR-005] every connection reads foreign_keys 1, journal_mode wal, synchronous 1, busy_timeout 5000, secure_delete 2 and trusted_schema 0', () => {
    const db = openWriter()
    const reader = openReader(db)

    expect(policyOf(db)).toEqual(POLICY)
    expect(policyOf(reader)).toEqual(POLICY)

    // A reopen of the same file gets the policy again: nothing relies on a value persisted by an
    // earlier connection (foreign_keys is per connection, 09 §8.1 "at every open").
    db.close()
    toClose.splice(toClose.indexOf(db), 1)
    expect(policyOf(openWriter())).toEqual(POLICY)
  })

  it('[ADR-005] a reader connection is query_only and refuses a write', () => {
    const db = openWriter()
    db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT) STRICT')
    db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'ore'])
    const reader = openReader(db)

    expect(pragma(reader, 'query_only')).toBe(1)
    expect(pragma(db, 'query_only')).toBe(0)
    expect(reader.all('SELECT id, body FROM notes')).toEqual([{ id: 'n1', body: 'ore' }])

    let thrown: unknown
    try {
      reader.all("INSERT INTO notes (id, body) VALUES ('n2', 'gem') RETURNING id")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SqliteInfrastructureError)
    expect((thrown as SqliteInfrastructureError).code).toBe('SQLITE_READONLY')
    expect(db.all('SELECT id FROM notes')).toEqual([{ id: 'n1' }])
  })

  it("[FM-106, CH-07] a writer blocked by another connection's lock waits up to busy_timeout and then fails the command with SQLITE_BUSY, never corrupting the file", () => {
    const path = join(dir, 'host.db')
    const db = openWriter()
    db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT) STRICT')
    const runner = new SqliteTransactionRunner(db)
    runner.inTransaction(() => db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'ore']))

    // Another connection holds the write lock for the whole attempt (09 §8.1: only a Host reader
    // or a checkpoint would, in production; a foreign writer stands in for it here).
    const holder = new DatabaseSync(path, { timeout: 0 })
    toClose.push(holder)
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO notes (id, body) VALUES ('n2', 'held')")

    const startedAt = Date.now()
    let thrown: unknown
    try {
      runner.inTransaction(() => db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n3', 'x']))
    } catch (error) {
      thrown = error
    }
    const waitedMs = Date.now() - startedAt

    expect(thrown).toBeInstanceOf(SqliteInfrastructureError)
    expect((thrown as SqliteInfrastructureError).code).toBe('SQLITE_BUSY')
    // Timer granularity differs per OS; SQLite sleeps in steps that add up to the timeout.
    expect(waitedMs).toBeGreaterThanOrEqual(4_500)
    expect(runner.isInTransaction()).toBe(false)

    holder.exec('COMMIT')
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('SELECT id FROM notes ORDER BY id')).toEqual([{ id: 'n1' }, { id: 'n2' }])
    // The command failed, the writer did not: the next command succeeds.
    runner.inTransaction(() => db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n3', 'x']))
    expect(db.all('SELECT id FROM notes ORDER BY id')).toEqual([
      { id: 'n1' },
      { id: 'n2' },
      { id: 'n3' }
    ])
  }, 20_000)

  it('[ADR-005] a pragma that reads back a different value fails the open', () => {
    // An in-memory database cannot be put in WAL mode: journal_mode reads back "memory", which
    // the writer policy must refuse instead of running without WAL.
    const raw = new DatabaseSync(':memory:')
    toClose.push(raw)

    let thrown: unknown
    try {
      applyConnectionPolicy(raw, 'writer')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConnectionPolicyError)
    expect(thrown).toMatchObject({ pragma: 'journal_mode', expected: 'wal', actual: 'memory' })
  })
})
