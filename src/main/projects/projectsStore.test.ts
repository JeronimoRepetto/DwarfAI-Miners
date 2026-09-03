import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { mineIdForPath } from '../domain/aggregate'
import { MAP_SPAWN_SITE_COUNT, type MineTier } from '../domain/types'
import { APP_DB_FILENAME, APP_SCHEMA_VERSION } from '../appDatabase/appDatabase'
import { createProjectsStore, type ProjectsResult, type ProjectsStore } from './projectsStore'

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
    store: createProjectsStore({ filePath: APP_DB_FILENAME, sqlite, platform: 'win32' })
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

    const db = await sqlite.open(APP_DB_FILENAME)
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
    const db = await sqlite.open(APP_DB_FILENAME)
    expect(db.all('PRAGMA user_version')).toEqual([{ user_version: APP_SCHEMA_VERSION }])
    db.close()
  })

  it('refuses a database from a version it does not know, instead of reporting no projects', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(APP_DB_FILENAME)
    seeded.exec('PRAGMA user_version = 99')
    seeded.close()

    const { store } = newStore(sqlite)
    const result = await store.list()
    expect(result).toMatchObject({ ok: false, failure: 'unsupported-schema' })
  })

  it('refuses a database that already holds a projects table with no version stamp', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(APP_DB_FILENAME)
    seeded.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
    seeded.close()

    const { store } = newStore(sqlite)
    expect(await store.list()).toMatchObject({ ok: false, failure: 'unsupported-schema' })
  })

  it('refuses every operation, not only the read', async () => {
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(APP_DB_FILENAME)
    seeded.exec('PRAGMA user_version = 99')
    seeded.close()

    const { store } = newStore(sqlite)
    expect(await store.declare({ path: PATH, at: 1 })).toMatchObject({ ok: false })
    expect(await store.upsertObserved({ path: PATH, at: 1 })).toMatchObject({ ok: false })
    expect(await store.get('mine:x')).toMatchObject({ ok: false })
    expect(await store.removeDeclared('mine:x')).toMatchObject({ ok: false })
  })
})

/**
 * The #92 query, run against real SQLite through the in-memory fake.
 *
 * These are deliberately not tests of a generated SQL string — that is
 * projectQuery.test.ts. Every rule here depends on what SQLite actually does
 * with a LIKE pattern, an ESCAPE clause, a NULL in an ORDER BY and a
 * comparison against a NULL column, and a canned result would hide all four.
 */
describe('projects store — searching by name (#92)', () => {
  /** Synthetic names only: a real project name from this machine is a privacy leak. */
  const NAMES = [
    'C:\\code\\Cafetería-Ñandú',
    'C:\\code\\Contáiner',
    'C:\\code\\smelter',
    'C:\\code\\100%-cotton',
    'C:\\code\\1000-monkeys',
    'C:\\code\\report_final',
    'C:\\code\\reportXfinal'
  ]

  async function seeded(): Promise<ProjectsStore> {
    const { store } = newStore()
    let at = 1_000
    for (const path of NAMES) {
      value(await store.upsertObserved({ path, at: (at += 1_000) }))
    }
    return store
  }

  async function found(store: ProjectsStore, nameContains: string): Promise<string[]> {
    const page = value(await store.query({ nameContains, sortBy: 'addedAt', direction: 'asc' }))
    return page.map((project) => project.name)
  }

  it('finds an accented name from the folded term the user typed', async () => {
    // The empirical result in #92: this LIKE matches nothing on the raw column
    // and matches here only because name_norm was written folded.
    expect(await found(await seeded(), 'cafeteria')).toEqual(['Cafetería-Ñandú'])
  })

  it('finds it from the accented spelling too, since both fold to the same thing', async () => {
    expect(await found(await seeded(), 'Cafetería')).toEqual(['Cafetería-Ñandú'])
  })

  it('ignores the case that was typed', async () => {
    expect(await found(await seeded(), 'CAFETERÍA')).toEqual(['Cafetería-Ñandú'])
  })

  it('matches a substring that is not a prefix, which is why this is not FTS5', async () => {
    // "typing `ontein` finds `container`" — the stated requirement, and the
    // whole reason option 1 was chosen. A token index would return nothing.
    expect(await found(await seeded(), 'ontain')).toEqual(['Contáiner'])
  })

  it('matches inside a folded accented word, not only around it', async () => {
    // 'Ñandú' folds to 'nandu', so this substring only exists after the fold.
    expect(await found(await seeded(), 'andu')).toEqual(['Cafetería-Ñandú'])
  })

  it('treats a typed percent sign as a literal instead of a wildcard', async () => {
    // The classic hole. Unescaped, this term becomes the pattern '%100%%' and
    // matches '1000-monkeys' as well — a search for one project returning two.
    expect(await found(await seeded(), '100%')).toEqual(['100%-cotton'])
  })

  it('treats a typed underscore as a literal instead of any-single-character', async () => {
    // Unescaped, 'report_final' would also match 'reportXfinal'.
    expect(await found(await seeded(), 'report_final')).toEqual(['report_final'])
  })

  it('answers a term containing the escape character instead of failing on it', async () => {
    // A lone backslash left unescaped is a dangling escape sequence, which is a
    // malformed pattern rather than a search. A project name can never contain
    // one — it is a path segment — so the honest answer is no matches, and the
    // thing being pinned is that SQLite is handed something it can run.
    const store = await seeded()
    expect(await found(store, 'a\\b')).toEqual([])
    expect(await found(store, '\\')).toEqual([])
  })

  it('returns every project when the term is blank', async () => {
    expect(await found(await seeded(), '   ')).toHaveLength(NAMES.length)
  })
})

describe('projects store — filtering by tier (#92)', () => {
  async function tiers(store: ProjectsStore, tier: MineTier): Promise<string[]> {
    const page = value(await store.query({ tier, sortBy: 'addedAt', direction: 'asc' }))
    return page.map((project) => project.name)
  }

  it('returns the projects measured at that tier', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 1_000, knownTier: 'gold' }))
    value(await store.upsertObserved({ path: OTHER, at: 2_000, knownTier: 'silver' }))
    expect(await tiers(store, 'gold')).toEqual(['Cafetería-Ñandú'])
    expect(await tiers(store, 'silver')).toEqual(['smelter'])
  })

  it('never matches an unmeasured project, bronze included (#41)', async () => {
    const { store } = newStore()
    // Declared and never walked: known_tier is NULL. tierOf() would draw this
    // mound as a provisional bronze, but that placeholder was never stored and
    // must not answer a filter — a bronze filter that swept up every project
    // nobody has measured is exactly the mistake #41 exists to prevent.
    value(await store.declare({ path: PATH, at: 1_000 }))
    value(await store.upsertObserved({ path: OTHER, at: 2_000, knownTier: 'bronze' }))

    expect(await tiers(store, 'bronze')).toEqual(['smelter'])
    for (const tier of ['copper', 'silver', 'gold', 'uranium'] as const) {
      expect(await tiers(store, tier)).toEqual([])
    }
  })

  it('combines the tier filter with the name search', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 1_000, knownTier: 'gold' }))
    value(await store.upsertObserved({ path: 'C:\\code\\Cafetería-Dos', at: 2_000 }))

    const page = value(
      await store.query({
        tier: 'gold',
        nameContains: 'cafeteria',
        sortBy: 'addedAt',
        direction: 'asc'
      })
    )
    expect(page.map((project) => project.name)).toEqual(['Cafetería-Ñandú'])
  })
})

describe('projects store — ordering (#92)', () => {
  it('sorts by when the project was added, in both directions', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 1_000 }))
    value(await store.upsertObserved({ path: OTHER, at: 2_000 }))

    const desc = value(await store.query({ sortBy: 'addedAt', direction: 'desc' }))
    expect(desc.map((project) => project.addedAt)).toEqual([2_000, 1_000])
    const asc = value(await store.query({ sortBy: 'addedAt', direction: 'asc' }))
    expect(asc.map((project) => project.addedAt)).toEqual([1_000, 2_000])
  })

  it('sorts by when the project was last opened, in both directions', async () => {
    const { store } = newStore()
    value(await store.upsertObserved({ path: PATH, at: 5_000 }))
    value(await store.upsertObserved({ path: OTHER, at: 9_000 }))

    const desc = value(await store.query({ sortBy: 'lastOpenedAt', direction: 'desc' }))
    expect(desc.map((project) => project.lastOpenedAt)).toEqual([9_000, 5_000])
    const asc = value(await store.query({ sortBy: 'lastOpenedAt', direction: 'asc' }))
    expect(asc.map((project) => project.lastOpenedAt)).toEqual([5_000, 9_000])
  })

  it('puts a project nobody has opened last by recency, and first by the reverse', async () => {
    const { store } = newStore()
    // Declared, never worked: last_opened_at is NULL, and SQLite sorts NULL
    // below every number. "Most recently worked first" then ends with the ones
    // never worked, which is the right reading of the order the user asked for.
    value(await store.declare({ path: PATH, at: 1_000 }))
    value(await store.upsertObserved({ path: OTHER, at: 2_000 }))

    const desc = value(await store.query({ sortBy: 'lastOpenedAt', direction: 'desc' }))
    expect(desc.map((project) => project.name)).toEqual(['smelter', 'Cafetería-Ñandú'])
    const asc = value(await store.query({ sortBy: 'lastOpenedAt', direction: 'asc' }))
    expect(asc.map((project) => project.name)).toEqual(['Cafetería-Ñandú', 'smelter'])
  })

  it('breaks a tie on the id, so the order is total and a page cannot shuffle', async () => {
    const { store } = newStore()
    // Same millisecond: without the id tiebreak SQLite may return these in
    // either order, and paging over a partial order skips rows.
    for (const path of ['C:\\code\\zinc', 'C:\\code\\alum', 'C:\\code\\mica']) {
      value(await store.upsertObserved({ path, at: 4_000 }))
    }

    const ids = value(await store.query({ sortBy: 'addedAt', direction: 'desc' })).map(
      (project) => project.id
    )
    expect(ids).toEqual([...ids].sort())
    // And the same answer again, rather than a fresh shuffle.
    expect(
      value(await store.query({ sortBy: 'addedAt', direction: 'desc' })).map(
        (project) => project.id
      )
    ).toEqual(ids)
  })
})

describe('projects store — paging (#92)', () => {
  async function paged(): Promise<ProjectsStore> {
    const { store } = newStore()
    for (let index = 0; index < 5; index += 1) {
      value(await store.upsertObserved({ path: `C:\\code\\seam-${index}`, at: 1_000 + index }))
    }
    return store
  }

  it('returns one page at a time, and the next page continues where it stopped', async () => {
    const store = await paged()
    const first = value(await store.query({ sortBy: 'addedAt', direction: 'asc', limit: 2 }))
    const second = value(
      await store.query({ sortBy: 'addedAt', direction: 'asc', limit: 2, offset: 2 })
    )
    expect(first.map((project) => project.name)).toEqual(['seam-0', 'seam-1'])
    expect(second.map((project) => project.name)).toEqual(['seam-2', 'seam-3'])
  })

  it('runs off the end of the table as an empty page, not as a failure', async () => {
    const store = await paged()
    expect(
      value(await store.query({ sortBy: 'addedAt', direction: 'asc', limit: 2, offset: 99 }))
    ).toEqual([])
  })

  it('caps a limit that asks for more than one page can hold', async () => {
    const store = await paged()
    const page = value(
      await store.query({ sortBy: 'addedAt', direction: 'asc', limit: Number.MAX_SAFE_INTEGER })
    )
    // Clamped, and the clamp is above this fixture, so every row still arrives.
    expect(page).toHaveLength(5)
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

  it('reports a refused query rather than answering it with no matches (#92)', async () => {
    // A search that finds nothing and a database that will not open are both
    // zero rows, and the second must never be shown as the first: a user typing
    // into a browse surface would read it as "that project is gone".
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const { store } = newStore(sqlite)
    expect(
      await store.query({ nameContains: 'cafeteria', sortBy: 'addedAt', direction: 'asc' })
    ).toMatchObject({
      ok: false,
      failure: 'locked'
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

/**
 * Where each project's mine stands on the world map (#136).
 *
 * The store is the home for it because the design's requirement is a
 * persistence requirement — "persist the assigned location so closing and
 * reopening DwarfAI-Miners does not move a mine" — and because "one unoccupied
 * location" is a question only the table that holds every project can answer.
 */
describe('projects store — where the mine stands on the map (#136)', () => {
  /** A store whose placement draws from a scripted source instead of Math.random. */
  function placingStore(sqlite: MemoryWritableSqlite, ...fractions: number[]): ProjectsStore {
    let index = 0
    return createProjectsStore({
      filePath: APP_DB_FILENAME,
      sqlite,
      platform: 'win32',
      random: () => fractions[index++ % fractions.length]!
    })
  }

  it('places a project the user declares', async () => {
    const store = placingStore(new MemoryWritableSqlite(), 0.5)
    const project = value(await store.declare({ path: PATH, at: 1_000 }))
    expect(project.mapSite).toBeGreaterThanOrEqual(1)
    expect(project.mapSite).toBeLessThanOrEqual(MAP_SPAWN_SITE_COUNT)
  })

  it('places a project discovered from a running session', async () => {
    const store = placingStore(new MemoryWritableSqlite(), 0.5)
    const project = value(await store.upsertObserved({ path: PATH, at: 1_000 }))
    expect(project.mapSite).toBeGreaterThanOrEqual(1)
    expect(project.mapSite).toBeLessThanOrEqual(MAP_SPAWN_SITE_COUNT)
  })

  it('never puts two projects on the same location', async () => {
    // One fraction for every call, all pointing at the front of the free list:
    // the second project can only avoid the first by consulting what is taken.
    const store = placingStore(new MemoryWritableSqlite(), 0)
    const first = value(await store.declare({ path: PATH, at: 1_000 }))
    const second = value(await store.declare({ path: OTHER, at: 2_000 }))
    expect(second.mapSite).not.toBe(first.mapSite)
  })

  it('never moves a mine that has already been placed', async () => {
    const sqlite = new MemoryWritableSqlite()
    const store = placingStore(sqlite, 0.9, 0.1, 0.4)
    const placed = value(await store.upsertObserved({ path: PATH, at: 1_000 }))

    value(await store.upsertObserved({ path: PATH, at: 2_000, provider: 'claude' }))
    value(await store.upsertObserved({ path: PATH, at: 3_000, knownTier: 'gold' }))
    value(await store.declare({ path: PATH, at: 4_000 }))

    expect(value(await store.get(placed.id))!.mapSite).toBe(placed.mapSite)
  })

  it('keeps the location across a close and reopen, which is the whole point', async () => {
    const sqlite = new MemoryWritableSqlite()
    const first = placingStore(sqlite, 0.73)
    const placed = value(await first.declare({ path: PATH, at: 1_000 }))
    await first.close()

    const second = placingStore(sqlite, 0.11)
    expect(value(await second.get(placed.id))!.mapSite).toBe(placed.mapSite)
  })

  /*
    The v2-to-v3 migration deliberately leaves every existing project unplaced
    rather than inventing 74 placements inside a transaction that must not fail.
    This is where those projects get their location: the next write places one
    that has none, so a user who upgrades sees their mines appear on the map as
    the poll loop touches them, without a migration having to guess.
  */
  it('places a project that was migrated in without a location', async () => {
    const sqlite = new MemoryWritableSqlite()
    const store = placingStore(sqlite, 0.5)
    value(await store.declare({ path: PATH, at: 1_000 }))
    const db = await sqlite.open(APP_DB_FILENAME)
    db.run('UPDATE projects SET map_site = NULL')
    db.close()

    const observed = value(await store.upsertObserved({ path: PATH, at: 2_000 }))

    expect(observed.mapSite).not.toBeNull()
  })

  /*
    Past 74 projects the design's "never the same location" cannot hold. The
    store records no location rather than a duplicate: absent is a state the
    panel already knows how to draw, and a sealed duplicate is not.
  */
  it('records no location once all of them are taken', async () => {
    const sqlite = new MemoryWritableSqlite()
    const store = placingStore(sqlite, 0.5)
    value(await store.declare({ path: PATH, at: 1_000 }))
    const db = await sqlite.open(APP_DB_FILENAME)
    for (let site = 1; site <= MAP_SPAWN_SITE_COUNT; site++) {
      db.run(
        `INSERT INTO projects (id, path, name, name_norm, added_at, last_opened_at, origin,
         last_provider, known_tier, map_site) VALUES (?, ?, ?, ?, ?, NULL, 'declared', NULL, NULL, ?)`,
        [`mine:filler-${site}`, `C:\filler\${site}`, `${site}`, `${site}`, 1, site]
      )
    }
    db.run('UPDATE projects SET map_site = NULL WHERE id = ?', [mineIdForPath(PATH, 'win32')])
    db.close()

    const observed = value(await store.upsertObserved({ path: PATH, at: 2_000 }))

    expect(observed.mapSite).toBeNull()
  })

  it('reads a location back through every way of reading a project', async () => {
    const sqlite = new MemoryWritableSqlite()
    const store = placingStore(sqlite, 0.31)
    const placed = value(await store.declare({ path: PATH, at: 1_000 }))

    const [listed] = value(await store.list())
    const [queried] = value(await store.query({ sortBy: 'addedAt', direction: 'asc' }))
    expect(listed!.mapSite).toBe(placed.mapSite)
    expect(queried!.mapSite).toBe(placed.mapSite)
  })

  it('reads a site a build with more locations wrote as no site at all', async () => {
    // The database is a file on the user's disk. A number this build has no
    // location for is "unplaced", never a guess — the same discipline
    // lastProvider and knownTier already use for a value they do not recognise.
    const sqlite = new MemoryWritableSqlite()
    const store = placingStore(sqlite, 0.5)
    const placed = value(await store.declare({ path: PATH, at: 1_000 }))
    const db = await sqlite.open(APP_DB_FILENAME)
    db.run('UPDATE projects SET map_site = ?', [MAP_SPAWN_SITE_COUNT + 1])
    db.close()

    expect(value(await store.get(placed.id))!.mapSite).toBeNull()
  })
})

/*
 * A TIER WALK IS A MEASUREMENT, wherever it happened (#156).
 *
 * The acceptance run filtered the browse by Cropper and got nothing, while two
 * cards on screen said Cropper. Display and filter were classifying by two
 * different rules: a card derives its tier from the weight the walk measured
 * (#155's cardTierFor), and the SQL filter reads `known_tier`, which only the
 * observer writes and only for a mine somebody is WORKING. A folder the user
 * declared and never opened therefore carried NULL forever, however many times
 * it had been walked.
 *
 * The column takes the measurement now, from any project the walk has weighed.
 * It stays #41-clean because only knownTierOf ever reaches it — a walk that has
 * not finished writes nothing at all — and it stays #92-clean because a
 * measurement is not a sighting: nothing here moves `last_opened_at`, so
 * declaring a folder still is not opening it.
 */
describe('projects store — recording a measured tier (#156)', () => {
  it('writes the tier onto a project the store already knows', async () => {
    const { store } = newStore()
    const declared = value(await store.declare({ path: PATH, at: 1_000 }))
    expect(declared.knownTier).toBeNull()

    const measured = value(await store.recordMeasuredTier({ path: PATH, knownTier: 'copper' }))

    expect(measured?.knownTier).toBe('copper')
    expect(value(await store.get(declared.id))!.knownTier).toBe('copper')
  })

  it('leaves a declaration a declaration: measuring is not opening', async () => {
    const { store } = newStore()
    const declared = value(await store.declare({ path: PATH, at: 1_000 }))

    await store.recordMeasuredTier({ path: PATH, knownTier: 'gold' })

    const after = value(await store.get(declared.id))!
    expect(after.lastOpenedAt).toBeNull()
    expect(after.origin).toBe('declared')
    expect(after.addedAt).toBe(1_000)
    expect(after.lastProvider).toBeNull()
  })

  it('keeps the location the project already stands on', async () => {
    const { store } = newStore()
    const declared = value(await store.declare({ path: PATH, at: 1_000 }))

    await store.recordMeasuredTier({ path: PATH, knownTier: 'silver' })

    expect(value(await store.get(declared.id))!.mapSite).toBe(declared.mapSite)
  })

  it('takes a re-walk’s newer verdict, because the card already shows it', async () => {
    // A project that grew past a threshold classifies differently, and the card
    // says so the moment the walk does. The column has to agree or the filter
    // goes back to disagreeing with the display.
    const { store } = newStore()
    await store.declare({ path: PATH, at: 1_000 })
    await store.recordMeasuredTier({ path: PATH, knownTier: 'copper' })

    const grown = value(await store.recordMeasuredTier({ path: PATH, knownTier: 'gold' }))

    expect(grown?.knownTier).toBe('gold')
  })

  it('creates nothing for a folder the store has never been shown', async () => {
    // A measurement is not how a project enters the list. Declaring and being
    // seen worked in are the only two ways in, and both are somebody's action.
    const { store } = newStore()

    const missing = value(await store.recordMeasuredTier({ path: OTHER, knownTier: 'gold' }))

    expect(missing).toBeNull()
    expect(value(await store.list())).toEqual([])
  })
})
