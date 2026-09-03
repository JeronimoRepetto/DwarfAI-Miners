import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import {
  APP_DB_FILENAME,
  APP_SCHEMA_VERSION,
  LEDGER_TABLES_SINCE,
  UnsupportedSchemaError,
  createAppDatabase,
  prepareAppSchema
} from './appDatabase'

const DB = 'C:\\userData\\projects-v1.db'

/** Table names present in a database, so an upgrade can be asserted by effect. */
function tables(db: { all: (sql: string) => Record<string, unknown>[] }): string[] {
  return db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name))
}

function version(db: { all: (sql: string) => Record<string, unknown>[] }): number {
  return Number(db.all('PRAGMA user_version')[0]!.user_version)
}

describe('app database — a fresh file', () => {
  it('creates both tenants and stamps the version it wrote', async () => {
    const database = createAppDatabase({ filePath: DB, sqlite: new MemoryWritableSqlite() })
    const db = await database.connect()

    expect(tables(db)).toContain('projects')
    expect(tables(db)).toContain('materials')
    expect(tables(db)).toContain('session_marks')
    expect(tables(db)).toContain('ledger_meta')
    expect(version(db)).toBe(APP_SCHEMA_VERSION)
  })

  it('opens the file the app has always used, so slice 1 keeps its rows', () => {
    // The database gained tables; it did not become a different database. A new
    // filename here would orphan every project the user has already declared.
    expect(APP_DB_FILENAME).toBe('projects-v1.db')
  })

  it('prepares once however many tenants ask at the same moment', async () => {
    // Two DatabaseSync handles on one file take turns at SQLITE_BUSY instead of
    // sharing a queue, so the ledger and the projects list share one.
    const sqlite = new MemoryWritableSqlite()
    const open = vi.spyOn(sqlite, 'open')
    const database = createAppDatabase({ filePath: DB, sqlite })

    const [first, second] = await Promise.all([database.connect(), database.connect()])

    expect(first).toBe(second)
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('app database — the v1 to v2 upgrade (#93)', () => {
  /** A database exactly as slice 1 left it: the projects table, stamped v1. */
  async function seedVersion1(sqlite: MemoryWritableSqlite): Promise<void> {
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL)')
    seeded.run('INSERT INTO projects (id, path) VALUES (?, ?)', ['mine:a', 'C:\\code\\forge'])
    seeded.exec('PRAGMA user_version = 1')
    seeded.close()
  }

  /*
    These two asserted the literal stamp `2` while v2 was the newest schema.
    #136 added v3, and a v1 database now walks BOTH steps in one open — so the
    subject of each is unchanged and the expectation is the current version
    rather than a number that has to be edited at every future bump.
  */
  it('adds the ledger tables and stamps up without touching the projects rows', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion1(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_SCHEMA_VERSION)
    expect(tables(db)).toContain('materials')
    expect(db.all('SELECT id FROM projects')).toEqual([{ id: 'mine:a' }])
  })

  it('is a no-op on a database already at the current version', async () => {
    const sqlite = new MemoryWritableSqlite()
    const first = await createAppDatabase({ filePath: DB, sqlite }).connect()
    first.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      7
    ])

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_SCHEMA_VERSION)
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
  })

  it('rolls the whole upgrade back when one of the new tables cannot be created', async () => {
    // The upgrade is one transaction, and this proves it by failing in the
    // MIDDLE of it: session_marks is the second table created, so materials is
    // already standing when the failure lands. A half-upgraded database stamped
    // v2 would refuse itself forever with the vault it promised only half there.
    const sqlite = new MemoryWritableSqlite()
    await seedVersion1(sqlite)
    const db = await sqlite.open(DB)
    db.exec('CREATE TABLE session_marks (nonsense TEXT)')

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toThrow()

    expect(version(db)).toBe(1)
    expect(tables(db)).not.toContain('materials')
    expect(tables(db)).not.toContain('ledger_meta')
    expect(db.all('SELECT id FROM projects')).toEqual([{ id: 'mine:a' }])
  })

  it('names the version the ledger tables arrived in, apart from the current one', async () => {
    // openLedgerStore reads this to know whether a database it cannot open has
    // ever held the ledger. It must not follow a later schema bump.
    expect(LEDGER_TABLES_SINCE).toBe(2)
  })
})

describe('app database — the v2 to v3 upgrade (#136)', () => {
  /** A database exactly as the v2 build left it: no map_site column anywhere. */
  async function seedVersion2(sqlite: MemoryWritableSqlite): Promise<void> {
    const seeded = await sqlite.open(DB)
    seeded.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        origin TEXT NOT NULL,
        last_provider TEXT,
        known_tier TEXT
      );
      CREATE TABLE materials (
        mine_id TEXT NOT NULL,
        material TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (mine_id, material)
      );
    `)
    seeded.run(
      `INSERT INTO projects (id, path, name, name_norm, added_at, last_opened_at, origin,
       last_provider, known_tier) VALUES (?, ?, ?, ?, ?, ?, 'declared', NULL, 'gold')`,
      ['mine:a', 'C:\\code\\forge', 'forge', 'forge', 10, 20]
    )
    seeded.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      7
    ])
    seeded.exec('PRAGMA user_version = 2')
    seeded.close()
  }

  it('adds the map site column and stamps v3, keeping every row', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion2(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(3)
    expect(db.all('SELECT id, known_tier, map_site FROM projects')).toEqual([
      { id: 'mine:a', known_tier: 'gold', map_site: null }
    ])
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
  })

  /*
    A project the user already has gets no site out of the migration, and that
    is the point: NULL means "nobody has placed this mine yet", which is what
    lets the store hand it one on the next write instead of the migration
    inventing 74 placements in a transaction that must not fail.
  */
  it('leaves existing projects unplaced rather than inventing a site for them', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion2(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(db.all('SELECT map_site FROM projects')).toEqual([{ map_site: null }])
  })

  it('walks a v1 database through both upgrades in one open', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL)')
    seeded.run('INSERT INTO projects (id, path) VALUES (?, ?)', ['mine:a', 'C:\\code\\forge'])
    seeded.exec('PRAGMA user_version = 1')
    seeded.close()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_SCHEMA_VERSION)
    expect(tables(db)).toContain('materials')
    expect(db.all('SELECT id, map_site FROM projects')).toEqual([{ id: 'mine:a', map_site: null }])
  })

  it('creates a fresh database with the column already there', async () => {
    const sqlite = new MemoryWritableSqlite()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_SCHEMA_VERSION)
    expect(db.all('SELECT map_site FROM projects')).toEqual([])
  })
})

describe('app database — versions it refuses', () => {
  it('refuses a version above the one this build knows', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec(`PRAGMA user_version = ${APP_SCHEMA_VERSION + 1}`)
    seeded.close()

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toThrow(
      UnsupportedSchemaError
    )
  })

  it('refuses an unstamped database that already holds a projects table', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
    seeded.close()

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toThrow(
      UnsupportedSchemaError
    )
  })

  it('leaves the refused file exactly as it found it', async () => {
    // Refusing is only better than discarding if nothing is written on the way
    // out — a downgraded app must be able to be downgraded back.
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('PRAGMA user_version = 9')
    seeded.exec('CREATE TABLE later_thing (id TEXT)')
    seeded.close()

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toThrow()

    const db = await sqlite.open(DB)
    expect(version(db)).toBe(9)
    expect(tables(db)).toEqual(['later_thing'])
  })
})

describe('app database — schemaVersion()', () => {
  it('reports the stamp without preparing anything', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('PRAGMA user_version = 1')
    seeded.close()

    const database = createAppDatabase({ filePath: DB, sqlite })

    expect(await database.schemaVersion()).toBe(1)
    const db = await sqlite.open(DB)
    expect(tables(db)).toEqual([])
  })

  it('answers null rather than throwing when the database cannot be asked', async () => {
    // This is the question a caller asks precisely because connect() failed;
    // it must not fail the same way.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')

    expect(await createAppDatabase({ filePath: DB, sqlite }).schemaVersion()).toBeNull()
  })
})

describe('prepareAppSchema', () => {
  it('reports the version it found in the refusal, for the log line', async () => {
    const sqlite = new MemoryWritableSqlite()
    const db = await sqlite.open(DB)
    db.exec('PRAGMA user_version = 42')

    expect(() => prepareAppSchema(db)).toThrow(/42/)
  })
})
