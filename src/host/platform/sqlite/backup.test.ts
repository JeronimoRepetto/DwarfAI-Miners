import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { FaultySqlite } from './testing/FaultySqlite'
import { openHostDb, type OpenHostDbOptions, type OpenedHostDb } from './migrations/runner'
import { defineMigration, type Migration } from './migrations/types'

// L5 (17 §1.5): the pre-migration backup of 09 §6.2 step 5 and §8.3 (ADR-005 item 6) over real
// database files, one temp dir per test. T1…T5 are test-only migrations; T1 stands in for
// migration 1 (it creates `schema_migrations` and sets the DwarfAI application_id).

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

function tableMigration(version: number): Migration {
  return defineMigration({
    version,
    name: `000${version}-t${version}`,
    sql: `CREATE TABLE t${version} (id INTEGER NOT NULL PRIMARY KEY) STRICT;`
  })
}

const [T2, T3, T4, T5] = [2, 3, 4, 5].map(tableMigration) as [
  Migration,
  Migration,
  Migration,
  Migration
]

/** 1 750 000 000 000 ms is 2025-06-15T15:06:40.000Z. */
const START = 1_750_000_000_000

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Tables, applied versions and t1 rows of a database file, read without writing it. */
function contents(file: string): { tables: string[]; versions: number[]; rows: unknown[] } {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row['name']))
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row['version']))
    const rows = db.prepare('SELECT id, label FROM t1 ORDER BY id').all()
    return { tables, versions, rows }
  } finally {
    db.close()
  }
}

describe('pre-migration backup (09 §6.2 step 5, §8.3; ADR-005 item 6)', () => {
  let dir: string
  let path: string
  let clock: FakeClock
  let log: RecordingDiagnosticsLog
  const toClose: SqliteDatabase[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-backup-'))
    path = join(dir, 'dwarfai.db')
    clock = new FakeClock(START)
    log = new RecordingDiagnosticsLog()
  })

  afterEach(async () => {
    closeAll()
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

  function closeAll(): void {
    for (const db of toClose.splice(0).reverse()) db.close()
  }

  function track<R extends ReturnType<typeof openHostDb>>(result: R): R {
    if (result.ok) toClose.push(result.value.db)
    return result
  }

  function open(overrides: Partial<OpenHostDbOptions> = {}): OpenedHostDb {
    const result = track(openHostDb(path, options(overrides)))
    if (!result.ok) throw new Error(`expected the open to succeed, got ${result.error}`)
    return result.value
  }

  function backups(): string[] {
    return readdirSync(dir)
      .filter((name) => name.startsWith('dwarfai.db.bak-'))
      .sort()
  }

  it('[ADR-005, FM-099] a pending migration on a non-empty file first writes a VACUUM INTO backup named with the from version', () => {
    const atV1 = open({ migrations: [T1] })
    atV1.db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'kept'])
    closeAll()
    clock.advance(60_000)

    expect(open({ migrations: [T1, T2] })).toMatchObject({ applied: [2] })

    expect(backups()).toEqual(['dwarfai.db.bak-v1-20250615T150740000Z'])
    expect(contents(join(dir, 'dwarfai.db.bak-v1-20250615T150740000Z'))).toEqual({
      tables: ['schema_migrations', 't1'],
      versions: [1],
      rows: [{ id: 1, label: 'kept' }]
    })
    expect(log.byEvent('db.backup')).toEqual([
      { level: 'info', event: 'db.backup', subsystem: 'host', outcome: 'ok' }
    ])
  })

  it('[ADR-005] only the three newest backups remain after a fourth migration', () => {
    open({ migrations: [T1] })
    closeAll()
    // Neighbours the rotation must never touch: a quarantined file and another database's backup.
    const neighbours = [
      'dwarfai.db.corrupt-20250101T000000000Z',
      'other.db.bak-v1-20250101T000000000Z'
    ]
    for (const name of neighbours) new DatabaseSync(join(dir, name)).close()
    const known = [T1, T2, T3, T4, T5]

    for (let head = 2; head <= 5; head++) {
      clock.advance(1_000)
      expect(open({ migrations: known.slice(0, head) })).toMatchObject({ applied: [head] })
      closeAll()
    }

    expect(backups()).toEqual([
      'dwarfai.db.bak-v2-20250615T150642000Z',
      'dwarfai.db.bak-v3-20250615T150643000Z',
      'dwarfai.db.bak-v4-20250615T150644000Z'
    ])
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(neighbours))
  })

  it('[ADR-005, FM-105, CH-06] when the backup cannot be written the runner does not migrate and the boot fails', () => {
    const atV1 = open({ migrations: [T1] })
    atV1.db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'kept'])
    closeAll()
    const before = { file: fileHash(path), listing: readdirSync(dir).sort() }
    // The disk fills up while VACUUM INTO writes: the copy is on disk, then SQLITE_FULL surfaces.
    const openWriter = (location: string): FaultySqlite => {
      const writer = FaultySqlite.open(location, { log })
      writer.failStatement({ match: /^VACUUM INTO/, code: 'SQLITE_FULL', when: 'after' })
      return writer
    }

    const result = track(openHostDb(path, options({ migrations: [T1, T2], openWriter })))

    expect(result).toEqual({ ok: false, error: 'BACKUP_FAILED' })
    // A backup is complete or absent: the partial copy is gone and nothing else was left.
    expect(readdirSync(dir).sort()).toEqual(before.listing)
    expect(fileHash(path)).toBe(before.file)
    expect(contents(path)).toEqual({
      tables: ['schema_migrations', 't1'],
      versions: [1],
      rows: [{ id: 1, label: 'kept' }]
    })
    expect(log.byEvent('db.backup')).toEqual([
      {
        level: 'error',
        event: 'db.backup',
        subsystem: 'host',
        outcome: 'failed',
        errCode: 'SQLITE_FULL'
      }
    ])
  })

  it('[ADR-005] an empty new file gets no backup', () => {
    // No file yet, then a zero-byte file (created but never written): both get migration 1 only.
    expect(open({ migrations: [T1] })).toMatchObject({ applied: [1] })
    closeAll()
    const zeroBytes = join(dir, 'zero', 'dwarfai.db')
    mkdirSync(dirname(zeroBytes))
    writeFileSync(zeroBytes, '')
    const result = track(openHostDb(zeroBytes, options({ migrations: [T1, T2] })))
    expect(result).toMatchObject({ ok: true, value: { applied: [1, 2] } })

    expect(backups()).toEqual([])
    expect(readdirSync(dirname(zeroBytes)).filter((name) => name.includes('.bak-'))).toEqual([])
    expect(log.byEvent('db.backup')).toEqual([])
  })

  it('[ADR-005, FM-107] a development build pointed at the release data directory writes no backup and leaves the directory byte-identical', () => {
    const known = [T1, T2, T3, T4, T5]
    for (let head = 1; head <= 4; head++) {
      clock.advance(1_000)
      open({ migrations: known.slice(0, head), releaseDataDir: dir })
      closeAll()
    }
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(readdirSync(dir).map((name) => [name, fileHash(join(dir, name))]))
    const before = snapshot()
    expect(Object.keys(before)).toHaveLength(4) // the database and its three backups
    clock.advance(1_000)

    const result = track(
      openHostDb(path, options({ migrations: known, buildKind: 'dev', releaseDataDir: dir }))
    )

    expect(result).toEqual({ ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' })
    expect(snapshot()).toEqual(before)
    expect(log.byEvent('db.backup')).toHaveLength(3)
  })

  it('[ADR-005, FM-105] a partial copy left by a crash during an earlier backup is removed and never counted as a backup', () => {
    open({ migrations: [T1] })
    closeAll()
    const leftover = 'dwarfai.db.bak-v1-20250101T000000000Z.partial'
    writeFileSync(join(dir, leftover), 'half a copy')
    clock.advance(1_000)

    expect(open({ migrations: [T1, T2] })).toMatchObject({ applied: [2] })

    expect(readdirSync(dir)).not.toContain(leftover)
    expect(backups()).toEqual(['dwarfai.db.bak-v1-20250615T150641000Z'])
  })

  it('[ADR-005] a backup that cannot be pruned is kept, logged, and the migration still runs', () => {
    open({ migrations: [T1] })
    closeAll()
    // A directory under an old backup's name: deleting it as a file fails.
    const stuck = 'dwarfai.db.bak-v1-20240101T000000000Z'
    mkdirSync(join(dir, stuck))
    const known = [T1, T2, T3, T4]
    for (let head = 2; head <= 4; head++) {
      clock.advance(1_000)
      expect(open({ migrations: known.slice(0, head) })).toMatchObject({ applied: [head] })
      closeAll()
    }

    expect(backups()).toEqual([
      stuck,
      'dwarfai.db.bak-v1-20250615T150641000Z',
      'dwarfai.db.bak-v2-20250615T150642000Z',
      'dwarfai.db.bak-v3-20250615T150643000Z'
    ])
    expect(log.byEvent('db.backup').at(-1)).toMatchObject({
      level: 'error',
      outcome: 'degraded',
      errCode: expect.any(String)
    })
  })

  it('[ADR-005, FM-099] a failing migration is rolled back, logged db.migration failed, and its pre-migration backup remains', () => {
    const atV1 = open({ migrations: [T1] })
    atV1.db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'kept'])
    closeAll()
    clock.advance(1_000)
    const failing = defineMigration({
      version: 2,
      name: '0002-failing',
      sql: 'INSERT INTO t1 (id, label) VALUES (1, 1);',
      up: (db) => db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'duplicate'])
    })

    expect(() => openHostDb(path, options({ migrations: [T1, failing] }))).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT' })
    )

    expect(backups()).toEqual(['dwarfai.db.bak-v1-20250615T150641000Z'])
    expect(contents(path)).toEqual({
      tables: ['schema_migrations', 't1'],
      versions: [1],
      rows: [{ id: 1, label: 'kept' }]
    })
    expect(log.byEvent('db.migration')).toEqual([
      {
        level: 'info',
        event: 'db.migration',
        subsystem: 'host',
        outcome: 'ok',
        msg: 'v0→v1',
        durationMs: 0
      },
      {
        level: 'error',
        event: 'db.migration',
        subsystem: 'host',
        outcome: 'failed',
        msg: 'v1→v2',
        errCode: 'SQLITE_CONSTRAINT'
      }
    ])
  })
})
