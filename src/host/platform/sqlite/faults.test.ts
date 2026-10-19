import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { FaultySqlite, SimulatedCrash } from './testing/FaultySqlite'

// L10 (17 §1.10) over real database files, one temp dir per test: a database infrastructure
// failure aborts only the current command, its transaction rolls back, nothing is half-written,
// the failure is logged (16 §2.1 c; 19 §9.5 `db.sqlite-error`) and the Host keeps running
// (13 FM-104, FM-106). A command here is one `inTransaction` call, as every Host write is
// (16 §2.2). No person-facing text comes out of this: disk-full copy is a design gap (13 §7
// I-13-08), so the caller gets the typed error and the log keeps the record.

const CREATE = 'CREATE TABLE notes (id INTEGER NOT NULL PRIMARY KEY, body TEXT NOT NULL) STRICT'
const INSERT = 'INSERT INTO notes (id, body) VALUES (?, ?)'
/** 09 §8.1; a literal, so a changed policy constant fails this test. */
const BUSY_TIMEOUT_MS = 5_000

describe('database faults during a command (16 §2.1; FM-104, FM-106)', () => {
  let dir: string
  let path: string
  let log: RecordingDiagnosticsLog
  let db: FaultySqlite
  let runner: SqliteTransactionRunner

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-faults-'))
    path = join(dir, 'dwarfai.db')
    log = new RecordingDiagnosticsLog()
    db = FaultySqlite.open(path, { log })
    db.exec(CREATE)
    runner = new SqliteTransactionRunner(db)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  function ids(): number[] {
    return db.all('SELECT id FROM notes ORDER BY id').map((row) => Number(row['id']))
  }

  function insert(id: number, body = `note ${id}`): void {
    runner.inTransaction(() => {
      db.run(INSERT, [id, body])
    })
  }

  it('[FM-104, CH-06] SQLITE_FULL during a command rolls back its transaction, nothing is half-written, and the next command succeeds after space is freed', () => {
    insert(1)
    db.fillDisk()
    // One command, two writes: the small row fits, the large one needs pages the disk lacks.
    const command = (): void =>
      runner.inTransaction(() => {
        db.run(INSERT, [2, 'small'])
        db.run(INSERT, [3, 'x'.repeat(256 * 1024)])
      })

    expect(command).toThrow(expect.objectContaining({ code: 'SQLITE_FULL' }))
    expect(ids()).toEqual([1])
    expect(runner.isInTransaction()).toBe(false)

    db.freeSpace()
    command()
    expect(ids()).toEqual([1, 2, 3])
    expect(log.byEvent('db.sqlite-error')).toEqual([
      { level: 'error', event: 'db.sqlite-error', subsystem: 'host', errCode: 'SQLITE_FULL' }
    ])
  })

  it('[FM-104] an injected SQLITE_IOERR aborts only the current command and is logged with its errCode', () => {
    insert(1)
    db.failStatement({ match: /^INSERT/, code: 'SQLITE_IOERR', when: 'before', times: 1 })

    expect(() => insert(2)).toThrow(expect.objectContaining({ code: 'SQLITE_IOERR' }))
    insert(3)

    expect(ids()).toEqual([1, 3])
    expect(log.byEvent('db.sqlite-error')).toEqual([
      { level: 'error', event: 'db.sqlite-error', subsystem: 'host', errCode: 'SQLITE_IOERR' }
    ])
  })

  it(
    '[FM-106, CH-07] a lock held by another connection makes a write wait and fail only after 5 000 ms',
    () => {
      insert(1)
      const lock = db.holdWriteLock()
      const started = performance.now()

      try {
        expect(() => insert(2)).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
      } finally {
        lock.release()
      }

      // 09 §8.1 busy_timeout 5 000 ms: SQLite sleeps in steps that sum to it; the clock reads may
      // round down by a few milliseconds.
      expect(performance.now() - started).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS - 20)
      insert(3)
      expect(ids()).toEqual([1, 3])
      expect(log.byEvent('db.sqlite-error')).toEqual([
        { level: 'error', event: 'db.sqlite-error', subsystem: 'host', errCode: 'SQLITE_BUSY' }
      ])
    },
    BUSY_TIMEOUT_MS * 4
  )

  it('[CH-11] a throw after commit N leaves exactly the first N commits', () => {
    db.crashAfterCommit(2)
    let crashedAt: number | null = null

    for (const id of [1, 2, 3, 4]) {
      try {
        insert(id)
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error
        crashedAt = id
        break
      }
    }

    expect(crashedAt).toBe(2)
    const reopened = new DatabaseSync(path, { readOnly: true })
    try {
      expect(reopened.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([
        { id: 1 },
        { id: 2 }
      ])
    } finally {
      reopened.close()
    }
  })
})
