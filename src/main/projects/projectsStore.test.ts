import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { mineIdForPath } from '../domain/aggregate'
import {
  PROJECTS_DB_FILENAME,
  PROJECTS_SCHEMA_VERSION,
  createProjectsStore,
  type ProjectsResult,
  type ProjectsStore
} from './projectsStore'

const PATH = 'C:\\code\\Cafetería-Ñandú'
const OTHER = 'C:\\code\\smelter'

function newStore(sqlite = new MemoryWritableSqlite()): {
  store: ProjectsStore
  sqlite: MemoryWritableSqlite
} {
  // The platform is passed in for the same reason every other port takes one:
  // the win32 id rules have to be assertable on any host (see platform-ports).
  return {
    sqlite,
    store: createProjectsStore({ filePath: PROJECTS_DB_FILENAME, sqlite, platform: 'win32' })
  }
}

function value<T>(result: ProjectsResult<T>): T {
  if (!result.ok) throw new Error(`expected a value, got failure "${result.failure}"`)
  return result.value
}

describe('projects store — declaring a project (#85)', () => {
  it('files it under the mine id the ledger already uses', async () => {
    const { store } = newStore()
    const project = value(await store.declare({ path: PATH, at: 1_000 }))
    // Not a second id scheme: whatever the ledger accrued under this id
    // attaches to the declared project.
    expect(project.id).toBe(mineIdForPath(PATH, 'win32'))
  })

  it('keeps the path as the user gave it and derives the display name from it', async () => {
    const { store } = newStore()
    const project = value(await store.declare({ path: PATH, at: 1_000 }))
    expect(project.path).toBe(PATH)
    expect(project.name).toBe('Cafetería-Ñandú')
    expect(project.origin).toBe('declared')
  })

  it('writes the accent-folded name at insert time, which is what makes the #92 search work', async () => {
    const { store, sqlite } = newStore()
    value(await store.declare({ path: PATH, at: 1_000 }))

    const db = await sqlite.open(PROJECTS_DB_FILENAME)
    // The query #92 will build. It matches only because the folded column was
    // written by the INSERT, which is why the normalization is a schema
    // requirement rather than a query-time concern.
    expect(db.all('SELECT name FROM projects WHERE name_norm LIKE ?', ['%cafeteria%'])).toEqual([
      { name: 'Cafetería-Ñandú' }
    ])
    db.close()
  })

  it('leaves lastOpenedAt unset, because declaring a project is not opening it', async () => {
    const { store } = newStore()
    const project = value(await store.declare({ path: PATH, at: 1_000 }))
    expect(project.addedAt).toBe(1_000)
    expect(project.lastOpenedAt).toBeNull()
    expect(project.lastProvider).toBeNull()
    expect(project.knownTier).toBeNull()
  })
})

describe('projects store — observing a project', () => {
  it('creates it as discovered, with the provider and tier that were seen', async () => {
    const { store } = newStore()
    const project = value(
      await store.upsertObserved({
        path: PATH,
        at: 2_000,
        provider: 'codex',
        knownTier: 'silver'
      })
    )
    expect(project.origin).toBe('discovered')
    expect(project.addedAt).toBe(2_000)
    expect(project.lastOpenedAt).toBe(2_000)
    expect(project.lastProvider).toBe('codex')
    expect(project.knownTier).toBe('silver')
  })

  it('keeps the first-seen date and advances the last-opened one (#92 sorts by both)', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 2_000, provider: 'claude' }))
    const project = value(await store.upsertObserved({ path: PATH, at: 5_000, provider: 'codex' }))
    expect(project.addedAt).toBe(2_000)
    expect(project.lastOpenedAt).toBe(5_000)
    expect(project.lastProvider).toBe('codex')
  })

  it('never moves lastOpenedAt backwards for an observation that arrives late', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 5_000 }))
    const project = value(await store.upsertObserved({ path: PATH, at: 2_000 }))
    expect(project.lastOpenedAt).toBe(5_000)
  })

  it('never erases a known tier with an observation that has none (#41)', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 2_000, knownTier: 'gold' }))
    // A poll where the walk has not finished passes no tier at all rather than
    // the provisional bronze; the recorded measurement must survive it.
    const project = value(await store.upsertObserved({ path: PATH, at: 3_000 }))
    expect(project.knownTier).toBe('gold')
  })

  it('never demotes a declared project to discovered', async () => {
    const { store } = newStore()
    value(await store.declare({ path: PATH, at: 1_000 }))
    const project = value(await store.upsertObserved({ path: PATH, at: 2_000, provider: 'claude' }))
    expect(project.origin).toBe('declared')
    expect(project.addedAt).toBe(1_000)
    expect(project.lastOpenedAt).toBe(2_000)
  })

  it('refreshes the display path when the same project is seen spelled differently', async () => {
    const { store } = newStore()
    value(await store.declare({ path: 'C:\\code\\Smelter', at: 1_000 }))
    const project = value(await store.upsertObserved({ path: 'C:\\CODE\\smelter', at: 2_000 }))
    // Same id on win32, so it is one project — and the freshest spelling is the
    // one worth showing, since the name is derived rather than cached (#85).
    expect(project.id).toBe(mineIdForPath('C:\\code\\Smelter', 'win32'))
    expect(project.path).toBe('C:\\CODE\\smelter')
    expect(value(await store.list())).toHaveLength(1)
  })
})

describe('projects store — declaring one that was already discovered', () => {
  it('promotes it and keeps everything already recorded', async () => {
    const { store } = newStore()
    value(
      await store.upsertObserved({ path: PATH, at: 2_000, provider: 'claude', knownTier: 'gold' })
    )
    const project = value(await store.declare({ path: PATH, at: 9_000 }))
    expect(project.origin).toBe('declared')
    expect(project.addedAt).toBe(2_000)
    expect(project.lastOpenedAt).toBe(2_000)
    expect(project.knownTier).toBe('gold')
  })
})

describe('projects store — removing a declaration (#85)', () => {
  it('removes a declared project no agent has ever been seen in', async () => {
    const { store } = newStore()
    const id = value(await store.declare({ path: PATH, at: 1_000 })).id
    expect(value(await store.removeDeclared(id))).toBe('removed')
    expect(value(await store.get(id))).toBeNull()
  })

  it('demotes a declared project that has been worked, rather than deleting its history', async () => {
    const { store } = newStore()
    const id = value(await store.declare({ path: PATH, at: 1_000 })).id
    value(await store.upsertObserved({ path: PATH, at: 2_000, provider: 'claude' }))

    expect(value(await store.removeDeclared(id))).toBe('demoted')
    const project = value(await store.get(id))
    expect(project?.origin).toBe('discovered')
    expect(project?.lastOpenedAt).toBe(2_000)
  })

  it('leaves a project that was never declared alone', async () => {
    const { store } = newStore()
    const id = value(await store.upsertObserved({ path: PATH, at: 2_000 })).id
    expect(value(await store.removeDeclared(id))).toBe('unchanged')
    expect(value(await store.get(id))).not.toBeNull()
  })

  it('says nothing changed for an id it has never heard of', async () => {
    const { store } = newStore()
    expect(value(await store.removeDeclared('mine:c:\\nowhere'))).toBe('unchanged')
  })
})

describe('projects store — reading back', () => {
  it('returns null for an id it does not hold', async () => {
    const { store } = newStore()
    expect(value(await store.get('mine:c:\\nowhere'))).toBeNull()
  })

  it('lists declared and discovered projects together', async () => {
    const { store } = newStore()
    value(await store.declare({ path: PATH, at: 1_000 }))
    value(await store.upsertObserved({ path: OTHER, at: 2_000 }))
    expect(
      value(await store.list())
        .map((project) => project.origin)
        .sort()
    ).toEqual(['declared', 'discovered'])
  })

  it('keeps what it wrote across a reopen', async () => {
    const sqlite = new MemoryWritableSqlite()
    const first = newStore(sqlite)
    value(await first.store.declare({ path: PATH, at: 1_000 }))
    await first.store.close()

    const second = newStore(sqlite)
    expect(value(await second.store.list())).toHaveLength(1)
  })
})

describe('projects store — schema version', () => {
  it('stamps the version it wrote on a fresh database', async () => {
    const { store, sqlite } = newStore()
    value(await store.list())
    const db = await sqlite.open(PROJECTS_DB_FILENAME)
    expect(db.all('PRAGMA user_version')).toEqual([{ user_version: PROJECTS_SCHEMA_VERSION }])
    db.close()
  })

  it('refuses a database from a version it does not know, instead of reporting no projects', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(PROJECTS_DB_FILENAME)
    seeded.exec('PRAGMA user_version = 99')
    seeded.close()

    const { store } = newStore(sqlite)
    const result = await store.list()
    expect(result).toMatchObject({ ok: false, failure: 'unsupported-schema' })
  })

  it('refuses a database that already holds a projects table with no version stamp', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(PROJECTS_DB_FILENAME)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
    seeded.close()

    const { store } = newStore(sqlite)
    expect(await store.list()).toMatchObject({ ok: false, failure: 'unsupported-schema' })
  })

  it('refuses every operation, not only the read', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(PROJECTS_DB_FILENAME)
    seeded.exec('PRAGMA user_version = 99')
    seeded.close()

    const { store } = newStore(sqlite)
    expect(await store.declare({ path: PATH, at: 1 })).toMatchObject({ ok: false })
    expect(await store.upsertObserved({ path: PATH, at: 1 })).toMatchObject({ ok: false })
    expect(await store.get('mine:x')).toMatchObject({ ok: false })
    expect(await store.removeDeclared('mine:x')).toMatchObject({ ok: false })
  })
})

describe('projects store — failures the app must not mistake for emptiness', () => {
  it('reports a locked database rather than an empty project list', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const { store } = newStore(sqlite)
    expect(await store.list()).toMatchObject({ ok: false, failure: 'locked' })
  })

  it('reports a runtime with no sqlite as unavailable', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('unavailable')
    const { store } = newStore(sqlite)
    expect(await store.declare({ path: PATH, at: 1 })).toMatchObject({
      ok: false,
      failure: 'unavailable'
    })
  })

  it('recovers once the database can be opened again', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const { store } = newStore(sqlite)
    expect(await store.list()).toMatchObject({ ok: false })

    sqlite.failWith(null)
    expect(value(await store.list())).toEqual([])
  })
})
