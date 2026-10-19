import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { openHostDb, type OpenHostDbOptions, type OpenedHostDb } from './runner'
import { defineMigration } from './types'

// L5 (17 §1.5): the migration runner of 09 §6.2 over real database files, one temp dir per test.
// T1…T3 are test-only migrations. T1 stands in for migration 1: like `0001-initial` (ISSUE-035) it
// creates `schema_migrations` with the 09 §4.1 DDL and sets the DwarfAI application_id.

const DWARFAI_APPLICATION_ID = 1146569033

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
    `PRAGMA application_id = ${DWARFAI_APPLICATION_ID};`
  ].join('\n')
})

const T2 = defineMigration({
  version: 2,
  name: '0002-t2',
  sql: [
    'CREATE TABLE t2 (',
    '  id INTEGER NOT NULL PRIMARY KEY,',
    '  t1_id INTEGER NOT NULL REFERENCES t1 (id) ON DELETE CASCADE',
    ') STRICT;',
    'CREATE INDEX t2_t1 ON t2 (t1_id);'
  ].join('\n')
})

const T3 = defineMigration({
  version: 3,
  name: '0003-t3',
  sql: 'CREATE TABLE t3 (id INTEGER NOT NULL PRIMARY KEY) STRICT;'
})

/** A backup-step spy's answer: it records the call and reports a written backup. */
function recorded(_call: unknown): { ok: true; value: undefined } {
  return { ok: true, value: undefined }
}

function pragma(db: Pick<SqliteDatabase, 'all'>, name: string): unknown {
  const [row] = db.all(`PRAGMA ${name}`)
  return row === undefined ? undefined : Object.values(row)[0]
}

function appliedRows(db: SqliteDatabase): unknown[] {
  return db.all('SELECT version, name, checksum, applied_at, app_version FROM schema_migrations')
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => String(row['name']))
}

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every schema object, every row of every table and the application_id, read without writing. */
function dump(file: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const schema = db
      .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name')
      .all() as { type: string; name: string }[]
    const rows = Object.fromEntries(
      schema
        .filter((entry) => entry.type === 'table')
        .map((entry) => [entry.name, db.prepare(`SELECT * FROM "${entry.name}" ORDER BY 1`).all()])
    )
    const [identity] = db.prepare('PRAGMA application_id').all()
    return { schema, rows, identity }
  } finally {
    db.close()
  }
}

describe('openHostDb (09 §6.2)', () => {
  let dir: string
  let path: string
  let clock: FakeClock
  const toClose: SqliteDatabase[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-migrations-'))
    path = join(dir, 'dwarfai.db')
    clock = new FakeClock(1_750_000_000_000)
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
      log: new RecordingDiagnosticsLog(),
      migrations: [T1],
      ...overrides
    }
  }

  function closeAll(): void {
    for (const db of toClose.splice(0).reverse()) db.close()
  }

  /** Keep an unexpectedly opened database closable, so a failing test still cleans up. */
  function track<R extends ReturnType<typeof openHostDb>>(result: R): R {
    if (result.ok) toClose.push(result.value.db)
    return result
  }

  function open(overrides: Partial<OpenHostDbOptions> = {}): OpenedHostDb {
    const result = track(openHostDb(path, options(overrides)))
    if (!result.ok) throw new Error(`expected the open to succeed, got ${result.error}`)
    return result.value
  }

  it('[ADR-005] a new empty file gets every known migration in one transaction and its schema_migrations rows', () => {
    const backupCalls: number[] = []

    const opened = open({
      migrations: [T1, T2],
      backup: { beforeMigrating: ({ fromVersion }) => recorded(backupCalls.push(fromVersion)) }
    })

    expect(opened).toMatchObject({ readOnly: false, version: 2, applied: [1, 2] })
    expect(backupCalls).toEqual([])
    expect(appliedRows(opened.db)).toEqual([
      {
        version: 1,
        name: '0001-t1',
        checksum: T1.checksum,
        applied_at: 1_750_000_000_000,
        app_version: '0.0.0-test'
      },
      {
        version: 2,
        name: '0002-t2',
        checksum: T2.checksum,
        applied_at: 1_750_000_000_000,
        app_version: '0.0.0-test'
      }
    ])
    expect(tableNames(opened.db)).toEqual(['schema_migrations', 't1', 't2'])
    expect(pragma(opened.db, 'application_id')).toBe(DWARFAI_APPLICATION_ID)
  })

  it('[ADR-005] a file at the build highest version reopens with nothing pending and nothing applied', () => {
    open({ migrations: [T1] })
    closeAll()
    clock.advance(1000)

    let reopened: OpenedHostDb | undefined
    expect(() => (reopened = open({ migrations: [T1, T2] }))).not.toThrow()
    if (reopened === undefined) return

    expect(reopened).toMatchObject({ readOnly: false, version: 2, applied: [2] })
    expect(appliedRows(reopened.db)).toMatchObject([
      { version: 1, applied_at: 1_750_000_000_000 },
      { version: 2, applied_at: 1_750_000_001_000 }
    ])
    const again = open({ migrations: [T1, T2] })
    expect(again).toMatchObject({ readOnly: false, version: 2, applied: [] })
  })

  it('[ADR-005, FM-099] a failure in migration N rolls back everything and leaves version N−1 with byte-identical data', () => {
    const atV1 = open({ migrations: [T1] })
    atV1.db.run('INSERT INTO t1 (id, label) VALUES (?, ?), (?, ?)', [1, 'one', 2, 'two'])
    closeAll()
    const before = { file: fileHash(path), data: dump(path) }
    const failing = defineMigration({
      version: 3,
      name: '0003-failing',
      sql: 'CREATE TABLE t3 (id INTEGER NOT NULL PRIMARY KEY) STRICT;',
      up: (db) => {
        db.exec('CREATE TABLE t3 (id INTEGER NOT NULL PRIMARY KEY) STRICT')
        db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [3, 'three'])
        throw new Error('migration 3 failed')
      }
    })

    expect(() => openHostDb(path, options({ migrations: [T1, T2, failing] }))).toThrow(
      'migration 3 failed'
    )

    expect(dump(path)).toEqual(before.data)
    expect(fileHash(path)).toBe(before.file)
  })

  it('[ADR-005] foreign_keys is OFF only around the migration transaction, a foreign_key_check row aborts it, and foreign_keys reads 1 afterwards', () => {
    open({ migrations: [T1] })
    closeAll()
    const seen: [string, unknown][] = []
    const backup = {
      beforeMigrating: ({ db }: { db: SqliteDatabase }) => {
        return recorded(seen.push(['backup', pragma(db, 'foreign_keys')]))
      }
    }
    const recording = defineMigration({
      version: 2,
      name: '0002-recording',
      sql: T2.sql,
      up: (db) => {
        seen.push(['up', pragma(db, 'foreign_keys')])
        db.exec(T2.sql)
      }
    })

    const opened = open({ migrations: [T1, recording], backup })

    expect(seen).toEqual([
      ['backup', 1],
      ['up', 0]
    ])
    expect(pragma(opened.db, 'foreign_keys')).toBe(1)
    closeAll()
    const before = dump(path)
    const dangling = defineMigration({
      version: 3,
      name: '0003-dangling',
      sql: 'INSERT INTO t2 (id, t1_id) VALUES (1, 999);'
    })

    expect(() => openHostDb(path, options({ migrations: [T1, recording, dangling] }))).toThrow(
      /foreign_key_check/
    )
    expect(dump(path)).toEqual(before)
  })

  it('[ADR-005, FM-101] a changed checksum of an applied migration refuses the open with SCHEMA_TAMPERED and writes nothing', () => {
    open({ migrations: [T1, T2] })
    closeAll()
    const before = { file: fileHash(path), data: dump(path) }
    const rewritten = defineMigration({ ...T2, sql: `${T2.sql}\n-- rewritten after shipping` })

    const result = track(openHostDb(path, options({ migrations: [T1, rewritten, T3] })))

    expect(result).toEqual({ ok: false, error: 'SCHEMA_TAMPERED' })
    expect(dump(path)).toEqual(before.data)
    expect(fileHash(path)).toBe(before.file)
  })

  it.each([
    ['a missing applied version', 'DELETE FROM schema_migrations WHERE version = 2', 3],
    [
      'a missing version above the build highest',
      'DELETE FROM schema_migrations WHERE version = 2',
      1
    ],
    [
      'a renamed applied version',
      "UPDATE schema_migrations SET name = 'renamed' WHERE version = 2",
      3
    ]
  ])(
    '[ADR-005, FM-101] a hand-edited history (%s) is refused with SCHEMA_TAMPERED and writes nothing',
    (_case, edit, buildKnows) => {
      open({ migrations: [T1, T2, T3] })
      closeAll()
      const raw = new DatabaseSync(path)
      raw.exec(edit)
      raw.close()
      const before = { file: fileHash(path), data: dump(path) }
      const migrations = [T1, T2, T3].slice(0, buildKnows)

      const result = track(openHostDb(path, options({ migrations })))

      expect(result).toEqual({ ok: false, error: 'SCHEMA_TAMPERED' })
      expect(dump(path)).toEqual(before.data)
      expect(fileHash(path)).toBe(before.file)
    }
  )

  it("[ADR-005, FM-100] a file whose highest version is above the build's opens read-only with db-read-only and no write is attempted", () => {
    open({ migrations: [T1, T2, T3] })
    closeAll()
    const before = { file: fileHash(path), data: dump(path) }
    const backupCalls: number[] = []

    const opened = open({
      migrations: [T1, T2],
      backup: { beforeMigrating: ({ fromVersion }) => recorded(backupCalls.push(fromVersion)) }
    })

    expect(opened).toMatchObject({ readOnly: true, capability: 'db-read-only', version: 3 })
    expect(pragma(opened.db, 'query_only')).toBe(1)
    expect(() => opened.db.run('INSERT INTO t3 (id) VALUES (?)', [1])).toThrow(
      expect.objectContaining({ code: 'SQLITE_READONLY' })
    )
    expect(backupCalls).toEqual([])
    closeAll()
    expect(dump(path)).toEqual(before.data)
    expect(fileHash(path)).toBe(before.file)
  })

  it("[ADR-005, FM-102, NFR-PERS-15] a SQLite file whose application_id is not DwarfAI's is refused NOT_A_DWARFAI_DB and left byte-identical (mtime and hash unchanged)", () => {
    // Shaped like the legacy projects-v1.db: application_id 0, tables with rows. A rollback
    // journal file, a cleanly closed WAL file and a WAL file the legacy app still holds open (its
    // -wal present) are probed differently, so each is covered.
    const variants = [
      { journalMode: 'DELETE', keepOpen: false },
      { journalMode: 'WAL', keepOpen: false },
      { journalMode: 'WAL', keepOpen: true }
    ]
    for (const { journalMode, keepOpen } of variants) {
      const legacy = join(dir, `projects-v1-${journalMode}-${keepOpen ? 'open' : 'closed'}.db`)
      const raw = new DatabaseSync(legacy)
      raw.exec(`PRAGMA journal_mode = ${journalMode}`)
      raw.exec(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT); INSERT INTO projects VALUES ('mine:/a', '/a')"
      )
      if (!keepOpen) raw.close()
      const before = {
        hash: fileHash(legacy),
        mtime: statSync(legacy).mtimeMs,
        dir: readdirSync(dir)
      }

      const result = track(openHostDb(legacy, options({ migrations: [T1, T2] })))

      expect(result).toEqual({ ok: false, error: 'NOT_A_DWARFAI_DB' })
      expect(fileHash(legacy)).toBe(before.hash)
      expect(statSync(legacy).mtimeMs).toBe(before.mtime)
      if (keepOpen) raw.close()
      else expect(readdirSync(dir)).toEqual(before.dir)
    }
  })

  it('[ADR-005, FM-102] a file with another application_id is refused NOT_A_DWARFAI_DB even with no tables', () => {
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA application_id = 42')
    raw.close()
    const before = fileHash(path)

    expect(track(openHostDb(path, options()))).toEqual({ ok: false, error: 'NOT_A_DWARFAI_DB' })
    expect(fileHash(path)).toBe(before)
  })

  it('[ADR-005, FM-107] a development build pointed at the release data directory refuses to migrate it', () => {
    open({ migrations: [T1], releaseDataDir: dir })
    closeAll()
    const before = { file: fileHash(path), data: dump(path) }
    const backupCalls: number[] = []
    const backup = { beforeMigrating: () => recorded(backupCalls.push(1)) }

    for (const buildKind of ['dev', 'test'] as const) {
      for (const releaseDataDir of [dir, `${dir}${sep}`, join(dir, 'sub', '..')]) {
        const result = track(
          openHostDb(path, options({ migrations: [T1, T2], buildKind, releaseDataDir, backup }))
        )
        expect(result).toEqual({ ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' })
      }
    }
    expect(dump(path)).toEqual(before.data)
    expect(fileHash(path)).toBe(before.file)

    // A database not created yet in the release data directory is not created by a dev build.
    const fresh = join(dir, 'fresh.db')
    const result = track(
      openHostDb(fresh, options({ migrations: [T1], buildKind: 'dev', releaseDataDir: dir }))
    )
    expect(result).toEqual({ ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' })
    expect(existsSync(fresh)).toBe(false)
  })

  it('[ADR-005, FM-107] the dev guard stops only a migration: a release build migrates the release data, a dev build its own data, and a dev build opens an up-to-date release file', () => {
    open({ migrations: [T1], releaseDataDir: dir })
    closeAll()

    expect(open({ migrations: [T1], buildKind: 'dev', releaseDataDir: dir })).toMatchObject({
      readOnly: false,
      applied: []
    })
    closeAll()
    expect(
      open({ migrations: [T1, T2], buildKind: 'dev', releaseDataDir: join(dir, 'release-data') })
    ).toMatchObject({ readOnly: false, applied: [2] })
    closeAll()
    expect(
      open({ migrations: [T1, T2, T3], buildKind: 'release', releaseDataDir: dir })
    ).toMatchObject({ readOnly: false, applied: [3] })
  })

  it.each([
    ['a gap', () => [T1, T3]],
    ['a reorder', () => [T2, T1]],
    ['a stale declared checksum', () => [T1, { ...T2, checksum: T3.checksum }]]
  ])(
    '[ADR-005] a build migration list with %s is a programming error raised before the file is opened',
    (_case, list) => {
      expect(() => openHostDb(path, options({ migrations: list() }))).toThrow(HostInvariantError)
      expect(existsSync(path)).toBe(false)
    }
  )

  it('[ADR-005] a line-end-only difference in an applied migration is not tampering (checksum over LF-normalised text)', () => {
    open({ migrations: [T1, T2] })
    closeAll()
    const crlfCheckout = defineMigration({ ...T2, sql: T2.sql.replace(/\n/g, '\r\n') })

    expect(crlfCheckout.checksum).toBe(T2.checksum)
    expect(open({ migrations: [T1, crlfCheckout] })).toMatchObject({ readOnly: false, applied: [] })
  })

  it('[S12.05, ADR-005] onMigrating is told once, before the backup and the first migration, only when a migration will run', () => {
    const journal: string[] = []
    const onMigrating = (): void => void journal.push('migrating')
    const backup = {
      beforeMigrating: ({ fromVersion }: { fromVersion: number }) =>
        recorded(journal.push(`backup v${fromVersion}`))
    }
    const traced = (migration: typeof T1): typeof T1 => ({
      ...migration,
      up: (db) => {
        journal.push(`up ${migration.name}`)
        migration.up(db)
      }
    })

    open({ migrations: [traced(T1)], onMigrating, backup })
    expect(journal).toEqual(['migrating', 'up 0001-t1'])
    closeAll()

    journal.length = 0
    open({ migrations: [T1, traced(T2), traced(T3)], onMigrating, backup })
    expect(journal).toEqual(['migrating', 'backup v1', 'up 0002-t2', 'up 0003-t3'])
    closeAll()

    // Nothing pending, a newer file opened read-only, and a refused dev build: no migration runs.
    journal.length = 0
    open({ migrations: [T1, T2, T3], onMigrating, backup })
    closeAll()
    open({ migrations: [T1, T2], onMigrating, backup })
    closeAll()
    const refused = track(
      openHostDb(
        join(dir, 'other.db'),
        options({ migrations: [T1], buildKind: 'dev', releaseDataDir: dir, onMigrating })
      )
    )
    expect(refused).toEqual({ ok: false, error: 'DEV_BUILD_ON_RELEASE_DATA' })
    expect(journal).toEqual([])
  })
})
