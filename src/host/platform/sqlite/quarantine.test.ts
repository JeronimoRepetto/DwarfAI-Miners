import { createHash } from 'node:crypto'
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { openHostDb, type OpenHostDbOptions } from './migrations/runner'
import { defineMigration } from './migrations/types'
import { quarantineUnreadableDb } from './quarantine'

// L5 (17 §1.5): unreadable state is quarantined, never treated as empty (09 §8.3; ADR-015 item 6,
// L-01; 13 FM-103), over real files, one temp dir per test. T1 stands in for migration 1.
// No person-facing text comes out of any of this: the notice after a quarantine is a design gap
// (13 §7 I-13-07), so the outcome is a log record and a fresh database only.

const T1 = defineMigration({
  version: 1,
  name: '0001-t1',
  sql: [
    'CREATE TABLE schema_migrations (',
    '  version INTEGER NOT NULL PRIMARY KEY CHECK (version >= 1),',
    '  name TEXT NOT NULL UNIQUE,',
    '  checksum TEXT NOT NULL CHECK (length(checksum) = 64),',
    '  applied_at INTEGER NOT NULL,',
    '  app_version TEXT NOT NULL',
    ') STRICT;',
    'CREATE TABLE t1 (id INTEGER NOT NULL PRIMARY KEY, label TEXT NOT NULL) STRICT;',
    'PRAGMA application_id = 1146569033;'
  ].join('\n')
})

/** 1 750 000 000 000 ms is 2025-06-15T15:06:40.000Z. */
const START = 1_750_000_000_000
const STAMP = '20250615T150640000Z'

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function garbage(bytes: number, seed: number): Buffer {
  return Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 131 + seed * 17 + 7) % 251))
}

describe('quarantine of an unreadable database (09 §8.3; FM-103)', () => {
  let dir: string
  let path: string
  let clock: FakeClock
  let log: RecordingDiagnosticsLog
  const toClose: SqliteDatabase[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-quarantine-'))
    path = join(dir, 'dwarfai.db')
    clock = new FakeClock(START)
    log = new RecordingDiagnosticsLog()
  })

  afterEach(async () => {
    for (const db of toClose.splice(0).reverse()) db.close()
    await rm(dir, { recursive: true, force: true })
  })

  function options(overrides: Partial<OpenHostDbOptions> = {}): OpenHostDbOptions {
    return {
      buildKind: 'release',
      releaseDataDir: join(dir, 'release-data'),
      appVersion: '0.0.0-test',
      clock,
      log,
      migrations: [T1],
      ...overrides
    }
  }

  function track<R extends ReturnType<typeof openHostDb>>(result: R): R {
    if (result.ok) toClose.push(result.value.db)
    return result
  }

  it('[FM-103] a file with garbage bytes is renamed dwarfai.db.corrupt-<stamp>, a fresh schema v1 file is created, and db.quarantined is logged', () => {
    const files = { '': garbage(8192, 1), '-wal': garbage(4096, 2), '-shm': garbage(32768, 3) }
    for (const [suffix, bytes] of Object.entries(files)) writeFileSync(`${path}${suffix}`, bytes)
    let result: ReturnType<typeof openHostDb> | undefined

    expect(() => (result = track(openHostDb(path, options())))).not.toThrow()

    expect(result).toMatchObject({ ok: true, value: { readOnly: false, version: 1, applied: [1] } })
    for (const [suffix, bytes] of Object.entries(files)) {
      expect(readFileSync(join(dir, `dwarfai.db.corrupt-${STAMP}${suffix}`))).toEqual(bytes)
    }
    expect(log.byEvent('db.quarantined')).toEqual([
      { level: 'error', event: 'db.quarantined', subsystem: 'host', errCode: 'SQLITE_NOTADB' }
    ])
  })

  it('[FM-103] the corrupt file is never read as an empty database and never deleted', () => {
    // A DwarfAI database with rows whose schema page is then damaged: the header (and its
    // application_id) is intact, the schema cannot be read.
    const seeded = track(openHostDb(path, options()))
    if (!seeded.ok) throw new Error(`seeding failed: ${seeded.error}`)
    seeded.value.db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'history'])
    toClose.splice(0).forEach((db) => db.close())
    const fd = openSync(path, 'r+')
    writeSync(fd, garbage(400, 4), 0, 400, 100)
    closeSync(fd)
    const corrupt = fileHash(path)
    clock.advance(1_000)
    let result: ReturnType<typeof openHostDb> | undefined

    expect(() => (result = track(openHostDb(path, options())))).not.toThrow()

    expect(result).toMatchObject({ ok: true, value: { applied: [1] } })
    const quarantined = join(dir, 'dwarfai.db.corrupt-20250615T150641000Z')
    expect(fileHash(quarantined)).toBe(corrupt)
    expect(log.byEvent('db.quarantined')).toEqual([
      { level: 'error', event: 'db.quarantined', subsystem: 'host', errCode: 'SQLITE_CORRUPT' }
    ])
    const fresh = new DatabaseSync(path, { readOnly: true })
    expect(fresh.prepare('SELECT count(*) AS n FROM t1').get()).toEqual({ n: 0 })
    fresh.close()
  })

  it('[FM-103, FM-107] a development build never quarantines a corrupt file in the release data directory', () => {
    writeFileSync(path, garbage(8192, 5))
    const before = readdirSync(dir)
    let result: ReturnType<typeof openHostDb> | undefined

    expect(
      () => (result = track(openHostDb(path, options({ buildKind: 'dev', releaseDataDir: dir }))))
    ).not.toThrow()

    expect(result).toEqual({ ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' })
    expect(readdirSync(dir)).toEqual(before)
    expect(readFileSync(path)).toEqual(garbage(8192, 5))
    expect(log.byEvent('db.quarantined')).toEqual([])
  })

  it('[FM-103] a quarantine that cannot move every file puts back the files it moved and never starts fresh beside them', () => {
    const files = { '': garbage(8192, 6), '-wal': garbage(4096, 7) }
    for (const [suffix, bytes] of Object.entries(files)) writeFileSync(`${path}${suffix}`, bytes)
    const cause = new SqliteInfrastructureError('SQLITE_NOTADB', 26, 'file is not a database')
    // The -wal cannot be moved (a locked file): the main file already was.
    const rename = (from: string, to: string): void => {
      if (from.endsWith('-wal')) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      renameSync(from, to)
    }

    const result = quarantineUnreadableDb(path, cause, { clock, log, rename })

    expect(result).toEqual({ ok: false, error: 'QUARANTINE_FAILED' })
    expect(readdirSync(dir).sort()).toEqual(['dwarfai.db', 'dwarfai.db-wal'])
    for (const [suffix, bytes] of Object.entries(files)) {
      expect(readFileSync(`${path}${suffix}`)).toEqual(bytes)
    }
    expect(log.byEvent('db.quarantined')).toEqual([
      {
        level: 'error',
        event: 'db.quarantined',
        subsystem: 'host',
        outcome: 'failed',
        errCode: 'EBUSY'
      }
    ])
  })

  it('[FM-103] an earlier quarantine with the same stamp is never overwritten', () => {
    writeFileSync(join(dir, `dwarfai.db.corrupt-${STAMP}`), 'an earlier quarantine')
    writeFileSync(path, garbage(8192, 8))
    const cause = new SqliteInfrastructureError('SQLITE_NOTADB', 26, 'file is not a database')

    const result = quarantineUnreadableDb(path, cause, { clock, log })

    expect(result).toEqual({ ok: true, value: { quarantinedAs: `${path}.corrupt-${STAMP}-1` } })
    expect(readFileSync(join(dir, `dwarfai.db.corrupt-${STAMP}`), 'utf8')).toBe(
      'an earlier quarantine'
    )
    expect(readFileSync(`${path}.corrupt-${STAMP}-1`)).toEqual(garbage(8192, 8))
  })
})
