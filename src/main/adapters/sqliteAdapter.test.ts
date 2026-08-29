import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemorySqlite } from './memorySqlite'
import { NodeSqlite } from './sqliteLike'

const SCHEMA = 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, archived INTEGER)'

describe('NodeSqlite', () => {
  let dir: string
  let dbPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-name-sqlite-'))
    dbPath = join(dir, 'state_5.sqlite')
    const seed = new DatabaseSync(dbPath)
    seed.exec(SCHEMA)
    seed.exec(
      "INSERT INTO threads VALUES ('t1', '\\\\?\\C:\\proj', 'gpt-5.6-luna', 0), " +
        "('t2', 'C:\\other', 'gpt-5.6-terra', 1)"
    )
    // WAL is how Codex actually keeps these databases; the adapter must read
    // them without taking a write lock or tripping over the -wal sidecar.
    seed.exec('PRAGMA journal_mode = WAL')
    seed.close()
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('opens a real database read-only and runs a parameterized query', async () => {
    const db = await new NodeSqlite().openReadOnly(dbPath)
    expect(db).not.toBeNull()
    try {
      expect(db!.all('SELECT id, model FROM threads WHERE archived = ?', [0])).toEqual([
        { id: 't1', model: 'gpt-5.6-luna' }
      ])
    } finally {
      db!.close()
    }
  })

  it('returns null for a missing database instead of throwing', async () => {
    expect(await new NodeSqlite().openReadOnly(join(dir, 'nope.sqlite'))).toBeNull()
  })

  it('never writes to the database it opens', async () => {
    const db = await new NodeSqlite().openReadOnly(dbPath)
    // Codex owns these files while it is running; a monitoring app must never
    // mutate them. The write is rejected by the read-only handle, so the row
    // count is unchanged.
    db!.all("INSERT INTO threads VALUES ('t3', 'x', 'y', 0)")
    expect(db!.all('SELECT count(*) AS n FROM threads')).toEqual([{ n: 2 }])
    db!.close()
  })

  it('reports a failed query as an empty result rather than crashing a scan', async () => {
    const db = await new NodeSqlite().openReadOnly(dbPath)
    // A Codex build without this table must degrade to "no rows", never throw
    // inside a poll tick.
    expect(db!.all('SELECT * FROM table_from_a_future_codex')).toEqual([])
    db!.close()
  })
})

describe('MemorySqlite', () => {
  it('serves rows for a defined database path', async () => {
    const sqlite = new MemorySqlite()
    sqlite.define('C:\\fake\\state_5.sqlite', SCHEMA, [
      "INSERT INTO threads VALUES ('t1', 'C:\\proj', 'gpt-5.6-luna', 0)"
    ])
    const db = await sqlite.openReadOnly('C:\\fake\\state_5.sqlite')
    expect(db!.all('SELECT id FROM threads')).toEqual([{ id: 't1' }])
    db!.close()
  })

  it('returns null for a path no test defined', async () => {
    expect(await new MemorySqlite().openReadOnly('C:\\fake\\missing.sqlite')).toBeNull()
  })

  it('keeps its data across open/close cycles so repeated scans see the same rows', async () => {
    const sqlite = new MemorySqlite()
    sqlite.define('db', SCHEMA, ["INSERT INTO threads VALUES ('t1', 'c', 'm', 0)"])
    for (let i = 0; i < 3; i++) {
      const db = await sqlite.openReadOnly('db')
      expect(db!.all('SELECT id FROM threads')).toHaveLength(1)
      db!.close()
    }
  })
})
