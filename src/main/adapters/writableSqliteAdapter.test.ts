import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from './memoryWritableSqlite'
import { NodeWritableSqlite, SqliteWriteError, classifySqliteFailure } from './sqliteWritable'

const SCHEMA = 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)'

describe('NodeWritableSqlite', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-name-writable-sqlite-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a database that does not exist yet and round-trips a write', async () => {
    const db = await new NodeWritableSqlite().open(join(dir, 'fresh.db'))
    try {
      db.exec(SCHEMA)
      db.run('INSERT INTO notes VALUES (?, ?)', ['n1', 'ore'])
      expect(db.all('SELECT id, body FROM notes')).toEqual([{ id: 'n1', body: 'ore' }])
    } finally {
      db.close()
    }
  })

  it('keeps what it wrote after the handle is closed and the file reopened', async () => {
    const path = join(dir, 'persist.db')
    const first = await new NodeWritableSqlite().open(path)
    first.exec(SCHEMA)
    first.run('INSERT INTO notes VALUES (?, ?)', ['n1', 'ore'])
    first.close()

    const second = await new NodeWritableSqlite().open(path)
    try {
      expect(second.all('SELECT id FROM notes')).toEqual([{ id: 'n1' }])
    } finally {
      second.close()
    }
  })

  it('throws a classified error for a failing query instead of reporting no rows', async () => {
    const db = await new NodeWritableSqlite().open(join(dir, 'strict.db'))
    try {
      // The read-only port degrades a failing query to [] on purpose; this one
      // must not, because "no rows" from the app's own store is indistinguishable
      // from an empty vault.
      expect(() => db.all('SELECT * FROM table_that_does_not_exist')).toThrow(SqliteWriteError)
    } finally {
      db.close()
    }
  })

  it('reports a file that is not a database as corrupt at open time', async () => {
    const path = join(dir, 'garbage.db')
    await writeFile(path, 'not a database, just bytes', 'utf8')
    await expect(new NodeWritableSqlite().open(path)).rejects.toMatchObject({
      failure: 'corrupt'
    })
  })

  it('classifies the driver messages the app has to tell apart', () => {
    expect(classifySqliteFailure(new Error('file is not a database'))).toBe('corrupt')
    expect(classifySqliteFailure(new Error('database disk image is malformed'))).toBe('corrupt')
    expect(classifySqliteFailure(new Error('database is locked'))).toBe('locked')
    expect(classifySqliteFailure(new Error('database table is busy'))).toBe('locked')
    expect(classifySqliteFailure(new Error('attempt to write a readonly database'))).toBe('io')
    expect(classifySqliteFailure('something nobody predicted')).toBe('io')
  })
})

describe('MemoryWritableSqlite', () => {
  it('runs the real SQL its caller wrote, rather than canned answers', async () => {
    const sqlite = new MemoryWritableSqlite()
    const db = await sqlite.open('projects-v1.db')
    db.exec(SCHEMA)
    db.run('INSERT INTO notes VALUES (?, ?)', ['n1', 'ore'])
    expect(db.all('SELECT body FROM notes WHERE id = ?', ['n1'])).toEqual([{ body: 'ore' }])
    db.close()
  })

  it('keeps its data across open/close cycles, exactly like a file on disk', async () => {
    const sqlite = new MemoryWritableSqlite()
    const first = await sqlite.open('projects-v1.db')
    first.exec(SCHEMA)
    first.run('INSERT INTO notes VALUES (?, ?)', ['n1', 'ore'])
    first.close()

    const second = await sqlite.open('projects-v1.db')
    expect(second.all('SELECT id FROM notes')).toEqual([{ id: 'n1' }])
    second.close()
  })

  it('fails the way a real driver fails, so callers can be tested against each state', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    await expect(sqlite.open('projects-v1.db')).rejects.toMatchObject({ failure: 'locked' })

    sqlite.failWith(null)
    const db = await sqlite.open('projects-v1.db')
    expect(db.all('SELECT 1 AS ok')).toEqual([{ ok: 1 }])
    db.close()
  })

  it('throws on a failing query rather than degrading to no rows', async () => {
    const sqlite = new MemoryWritableSqlite()
    const db = await sqlite.open('projects-v1.db')
    expect(() => db.all('SELECT * FROM table_that_does_not_exist')).toThrow(SqliteWriteError)
    db.close()
  })
})
