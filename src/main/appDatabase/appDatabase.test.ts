import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import type { WritableSqliteDb } from '../adapters/sqliteWritable'
import {
  APP_COMPAT_FLOOR,
  APP_DB_FILENAME,
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
    // AMENDED for #231: a third tenant, and it has to be created on the v0
    // path as well as by the upgrade — a fresh install never walks the steps.
    expect(tables(db)).toContain('launched_sessions')
    expect(version(db)).toBe(APP_COMPAT_FLOOR)
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

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
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

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
  })

  it('rolls the whole convergence back when one of the new tables cannot be created', async () => {
    // AMENDED for #575: convergence checks a table's PRESENCE, not its shape,
    // so a pre-existing TABLE named session_marks (however malformed) would
    // now be read as "already there" and silently skipped — the conflict this
    // test used to force is gone by design. A VIEW of the same name still
    // forces a real failure, because CREATE TABLE and CREATE VIEW share one
    // namespace in sqlite_master: `hasTable` (type = 'table') does not count
    // it as present, so convergence still attempts the CREATE and SQLite still
    // refuses the name collision. That keeps the guarantee this test exists
    // for — one convergence is one transaction, and a failure partway through
    // (materials is the table created just before session_marks) rolls back
    // everything, never leaving a half-converged, half-stamped file.
    const sqlite = new MemoryWritableSqlite()
    await seedVersion1(sqlite)
    const db = await sqlite.open(DB)
    db.exec('CREATE VIEW session_marks AS SELECT 1 AS nonsense')

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

  /*
    AMENDED for #231: this asserted the literal stamp `3` while v3 was the
    newest schema, and a v2 database now walks both remaining steps in one
    open. Subject unchanged — the column arrives and every row survives — with
    the expectation moved to the current version, as the two v1→v2 tests above
    already were for the same reason.
  */
  it('adds the map site column and stamps up, keeping every row', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion2(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
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

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(tables(db)).toContain('materials')
    expect(db.all('SELECT id, map_site FROM projects')).toEqual([{ id: 'mine:a', map_site: null }])
  })

  it('creates a fresh database with the column already there', async () => {
    const sqlite = new MemoryWritableSqlite()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT map_site FROM projects')).toEqual([])
  })
})

describe('app database — the v3 to v4 upgrade (#231)', () => {
  /** A database exactly as the v3 build left it: no launch register anywhere. */
  async function seedVersion3(sqlite: MemoryWritableSqlite): Promise<void> {
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
        known_tier TEXT,
        map_site INTEGER
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
       last_provider, known_tier, map_site) VALUES (?, ?, ?, ?, ?, ?, 'declared', NULL, 'gold', 4)`,
      ['mine:a', 'C:\\code\\forge', 'forge', 'forge', 10, 20]
    )
    seeded.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      7
    ])
    seeded.exec('PRAGMA user_version = 3')
    seeded.close()
  }

  /*
    AMENDED for #169 (was: `expect(version(db)).toBe(4)`). v4 is no longer the
    newest schema, so a v3 database now walks the hidden_at step as well in the
    same open. Subject unchanged — the launch register arrives and every row
    survives — with the literal stamp moved to the current version, exactly as
    the v2→v3 test above was amended for #231 for the same reason.
  */
  it('adds the launch register and stamps v4, keeping every row', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion3(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(tables(db)).toContain('launched_sessions')
    expect(db.all('SELECT id, map_site FROM projects')).toEqual([{ id: 'mine:a', map_site: 4 }])
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
  })

  it('walks a v1 database through every upgrade in one open', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL)')
    seeded.run('INSERT INTO projects (id, path) VALUES (?, ?)', ['mine:a', 'C:\\code\\forge'])
    seeded.exec('PRAGMA user_version = 1')
    seeded.close()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(tables(db)).toContain('materials')
    expect(tables(db)).toContain('launched_sessions')
    expect(db.all('SELECT id, map_site FROM projects')).toEqual([{ id: 'mine:a', map_site: null }])
  })

  it('leaves the vault where it moved in, whatever the current schema is', () => {
    // The launch register arriving in v4 must not drag LEDGER_TABLES_SINCE up
    // with it: openLedgerStore reads that to know whether a database it cannot
    // open has ever held the vault, and a later bump is not when it moved in.
    expect(LEDGER_TABLES_SINCE).toBe(2)
    expect(APP_COMPAT_FLOOR).toBeGreaterThan(LEDGER_TABLES_SINCE)
  })
})

describe('app database — the v4 to v5 upgrade (#169)', () => {
  /** A database exactly as the v4 build left it: no hidden_at column anywhere. */
  async function seedVersion4(sqlite: MemoryWritableSqlite): Promise<void> {
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
        known_tier TEXT,
        map_site INTEGER
      );
      CREATE TABLE materials (
        mine_id TEXT NOT NULL,
        material TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (mine_id, material)
      );
      CREATE TABLE launched_sessions (
        launch_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mine_path TEXT NOT NULL,
        pid INTEGER NOT NULL,
        proc_start_ms INTEGER NOT NULL
      );
    `)
    seeded.run(
      `INSERT INTO projects (id, path, name, name_norm, added_at, last_opened_at, origin,
       last_provider, known_tier, map_site) VALUES (?, ?, ?, ?, ?, ?, 'declared', NULL, 'gold', 4)`,
      ['mine:a', 'C:\\code\\forge', 'forge', 'forge', 10, 20]
    )
    seeded.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      7
    ])
    seeded.exec('PRAGMA user_version = 4')
    seeded.close()
  }

  it('adds the tracking flag and stamps v5, keeping every row', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion4(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT id, known_tier, map_site, hidden_at FROM projects')).toEqual([
      { id: 'mine:a', known_tier: 'gold', map_site: 4, hidden_at: null }
    ])
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
  })

  /*
   * The migration flags nothing, and that is the point: NULL means "the user
   * still tracks this mine", so every project somebody already has stays on the
   * map and in the list. A default of anything else would delete the user's
   * whole valley on the upgrade that added the ability to delete one.
   */
  it('leaves every project the user already had tracked', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion4(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(db.all('SELECT hidden_at FROM projects')).toEqual([{ hidden_at: null }])
  })

  it('walks a v1 database through every upgrade in one open', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL)')
    seeded.run('INSERT INTO projects (id, path) VALUES (?, ?)', ['mine:a', 'C:\\code\\forge'])
    seeded.exec('PRAGMA user_version = 1')
    seeded.close()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(tables(db)).toContain('materials')
    expect(tables(db)).toContain('launched_sessions')
    expect(db.all('SELECT id, map_site, hidden_at FROM projects')).toEqual([
      { id: 'mine:a', map_site: null, hidden_at: null }
    ])
  })

  it('creates a fresh database with the column already there', async () => {
    const sqlite = new MemoryWritableSqlite()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT hidden_at FROM projects')).toEqual([])
  })
})

/* --- MCP subtask delegation: the routedByJev column (#511) — one block, appended --- */
/*
 * AMENDED for #575: this block was titled "the v5 to v6 upgrade" while the
 * stamp counted every schema change. routed_by_jev was always additive — the
 * column is nullable and no existing reader depended on its absence — so
 * bumping the counter for it was the mistake #575 corrects, not a genuine
 * compatibility break. The column still arrives exactly as before; it simply
 * no longer moves the floor a build has to declare. See the last test in this
 * block for the transitional stamp-6 case #575 exists to fix.
 */
describe('app database — the routed-by-Jev column stays additive (#511, #575)', () => {
  /** A database exactly as the v5 build left it: no routed_by_jev column anywhere. */
  async function seedVersion5(sqlite: MemoryWritableSqlite): Promise<void> {
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
        known_tier TEXT,
        map_site INTEGER,
        hidden_at INTEGER
      );
      CREATE TABLE materials (
        mine_id TEXT NOT NULL,
        material TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (mine_id, material)
      );
      CREATE TABLE launched_sessions (
        launch_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mine_path TEXT NOT NULL,
        pid INTEGER NOT NULL,
        proc_start_ms INTEGER NOT NULL
      );
    `)
    seeded.run(
      `INSERT INTO launched_sessions
       (launch_id, provider, session_id, mine_path, pid, proc_start_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['launch:1', 'codex', 'thread-1', 'C:\\work\\project', 4242, 1_788_001_972_136]
    )
    seeded.exec('PRAGMA user_version = 5')
    seeded.close()
  }

  // AMENDED for #575 (was: "adds the routed-by-Jev column and stamps v6,
  // keeping every row"). The column still arrives and every row still
  // survives; only the destination stamp changed, from a counter bump to the
  // pinned floor.
  it('adds the routed-by-Jev column by convergence, keeping the floor at 5', async () => {
    const sqlite = new MemoryWritableSqlite()
    await seedVersion5(sqlite)

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(5)
    expect(db.all('SELECT launch_id, routed_by_jev FROM launched_sessions')).toEqual([
      { launch_id: 'launch:1', routed_by_jev: null }
    ])
  })

  /*
   * The migration flags nothing, and that is the point: NULL is what
   * `toLaunch` (launchedSessionStore.ts) reads as `routedByJev: false` — a
   * launch from before this column existed was never routed by Jev, because
   * Jev-routed launches did not exist yet either.
   */
  it('creates a fresh database with the column already there', async () => {
    const sqlite = new MemoryWritableSqlite()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT routed_by_jev FROM launched_sessions')).toEqual([])
  })

  /*
   * #575: a dev build stamped a real user's file at 6 for exactly this
   * additive column (#511) — 40 mines and 562M mined tokens became
   * unreadable to the released 0.12.0 build, which only knew up to 5, for a
   * change nothing in 0.12.0's vocabulary needed protecting from. A stamp of
   * 6 is the one value this build normalizes down rather than refusing: it
   * converges the file exactly like any other and restamps it at the floor,
   * which is the fix that restores that machine's access.
   */
  it('normalizes a stamp of 6 down to the floor, without losing what it already held', async () => {
    const sqlite = new MemoryWritableSqlite()
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
        known_tier TEXT,
        map_site INTEGER,
        hidden_at INTEGER
      );
      CREATE TABLE materials (
        mine_id TEXT NOT NULL,
        material TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (mine_id, material)
      );
      CREATE TABLE session_marks (
        key TEXT PRIMARY KEY NOT NULL,
        tokens INTEGER NOT NULL,
        seen_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_meta (
        key TEXT PRIMARY KEY NOT NULL,
        migrated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        mines INTEGER NOT NULL,
        sessions INTEGER NOT NULL
      );
      CREATE TABLE launched_sessions (
        launch_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mine_path TEXT NOT NULL,
        pid INTEGER NOT NULL,
        proc_start_ms INTEGER NOT NULL,
        routed_by_jev INTEGER
      );
    `)
    seeded.run(
      `INSERT INTO projects (id, path, name, name_norm, added_at, last_opened_at, origin,
       last_provider, known_tier, map_site, hidden_at) VALUES (?, ?, ?, ?, ?, ?, 'declared', NULL, 'gold', 4, NULL)`,
      ['mine:a', 'C:\\code\\forge', 'forge', 'forge', 10, 20]
    )
    seeded.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      562_000_000
    ])
    seeded.run(
      `INSERT INTO launched_sessions
       (launch_id, provider, session_id, mine_path, pid, proc_start_ms, routed_by_jev)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['launch:1', 'codex', 'thread-1', 'C:\\work\\project', 4242, 1_788_001_972_136, 1]
    )
    seeded.exec('PRAGMA user_version = 6')
    seeded.close()

    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()

    expect(version(db)).toBe(5)
    expect(db.all('SELECT id, map_site FROM projects')).toEqual([{ id: 'mine:a', map_site: 4 }])
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 562_000_000 }])
    expect(db.all('SELECT routed_by_jev FROM launched_sessions')).toEqual([{ routed_by_jev: 1 }])
  })
})
/* --- end of the #511 block ---------------------------------------------------- */

describe('app database — versions it refuses', () => {
  // AMENDED for #575: floor + 1 is 6, and 6 is now the one stamp this build
  // normalizes rather than refuses (see the #511/#575 block above) — it was
  // never a real break, only a counter bumped for an additive column. floor +
  // 2 is a stamp nothing has ever shipped and nothing here special-cases, so
  // it is what still proves a genuinely newer file gets refused.
  it('refuses a version above the one this build knows', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec(`PRAGMA user_version = ${APP_COMPAT_FLOOR + 2}`)
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

  /*
   * #572: the two refusals above read the same in a stack trace but are
   * opposite advice for the user — a version above this build's is a NEWER
   * build's file (updating fixes it), while an unstamped projects table is a
   * file this build never wrote at all (there is no version to walk up from).
   * `reason` is what lets a caller two layers up tell them apart without
   * re-parsing the message string.
   */
  // AMENDED for #575: same reason as the test above — floor + 1 (6) is the
  // normalized stamp, not a refusal, so this needs floor + 2 to still exercise
  // a genuine "newer" refusal.
  it('marks a version above this build as newer, not merely unsupported', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec(`PRAGMA user_version = ${APP_COMPAT_FLOOR + 2}`)
    seeded.close()

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toMatchObject({
      reason: 'newer'
    })
  })

  it('marks an unstamped projects table as unstamped, not newer', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
    seeded.close()

    await expect(createAppDatabase({ filePath: DB, sqlite }).connect()).rejects.toMatchObject({
      reason: 'unstamped'
    })
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

describe('app database — convergence, not a version walk (#575)', () => {
  /** Every exec() call `prepareAppSchema` makes on this handle, in order. */
  function spyOnExec(db: WritableSqliteDb): string[] {
    const calls: string[] = []
    const real = db.exec.bind(db)
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      calls.push(sql)
      real(sql)
    })
    return calls
  }

  it('brings a stamp-1 database to the floor in one open, stamping it exactly once', async () => {
    // The old UPGRADES walk stamped 2, then 3, then 4, then 5 — a separate
    // PRAGMA write per step. Convergence checks presence once and writes the
    // floor once; there is no intermediate stamp to observe from outside.
    const sqlite = new MemoryWritableSqlite()
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
    `)
    seeded.run(
      `INSERT INTO projects (id, path, name, name_norm, added_at, last_opened_at, origin,
       last_provider, known_tier) VALUES (?, ?, ?, ?, ?, ?, 'declared', NULL, 'gold')`,
      ['mine:a', 'C:\\code\\forge', 'forge', 'forge', 10, 20]
    )
    seeded.exec('PRAGMA user_version = 1')
    const calls = spyOnExec(seeded)

    prepareAppSchema(seeded)

    const stampWrites = calls.filter((sql) => sql.includes('PRAGMA user_version ='))
    expect(stampWrites).toEqual([`PRAGMA user_version = ${APP_COMPAT_FLOOR}`])
    expect(version(seeded)).toBe(APP_COMPAT_FLOOR)
    expect(tables(seeded)).toContain('materials')
    expect(tables(seeded)).toContain('launched_sessions')
    expect(seeded.all('SELECT id FROM projects')).toEqual([{ id: 'mine:a' }])
  })

  it('changes nothing on a second, already-converged open', async () => {
    const sqlite = new MemoryWritableSqlite()
    const first = await createAppDatabase({ filePath: DB, sqlite }).connect()
    first.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
      'mine:a',
      'gold',
      7
    ])

    const db = await sqlite.open(DB)
    const calls = spyOnExec(db)

    prepareAppSchema(db)

    // Nothing to create, nothing to add, nothing to restamp — the file is
    // already what this build expects, so nothing gets written a second time.
    expect(calls).toEqual([])
    expect(version(db)).toBe(APP_COMPAT_FLOOR)
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 7 }])
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
