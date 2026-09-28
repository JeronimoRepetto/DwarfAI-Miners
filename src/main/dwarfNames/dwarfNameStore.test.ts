import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase, type AppDatabase } from '../appDatabase/appDatabase'
import {
  createMemoryDwarfNameStore,
  createSqliteDwarfNameStore,
  type DwarfNameStore,
  type PersistedDwarfName
} from './dwarfNameStore'

const DB = 'C:\\userData\\projects-v1.db'

function named(overrides: Partial<PersistedDwarfName> = {}): PersistedDwarfName {
  return {
    dwarfId: 'claude:session-1:agent-9',
    provider: 'claude',
    customName: 'Stonebeard',
    setAt: 1_788_001_972_136,
    ...overrides
  }
}

function open(sqlite = new MemoryWritableSqlite()): {
  store: DwarfNameStore
  database: AppDatabase
} {
  const database = createAppDatabase({ filePath: DB, sqlite })
  return { store: createSqliteDwarfNameStore({ database }), database }
}

describe('the dwarf names on disk (#635)', () => {
  it('has nothing to say on a machine where nobody renamed a dwarf', async () => {
    await expect(open().store.list()).resolves.toEqual([])
  })

  /*
   * The point of the table: a name given in one run of the app is there in the next. Two stores
   * over one database stand in for the two runs, as the real app reopens the same file.
   */
  it('hands a name given in one run to the run after it', async () => {
    const sqlite = new MemoryWritableSqlite()
    await open(sqlite).store.put(named())

    await expect(open(sqlite).store.list()).resolves.toEqual([named()])
  })

  it('replaces a dwarf’s name rather than keeping two for it', async () => {
    const { store } = open()
    await store.put(named())
    await store.put(named({ customName: 'Ironfoot', setAt: 1_788_001_972_999 }))

    await expect(store.list()).resolves.toEqual([
      named({ customName: 'Ironfoot', setAt: 1_788_001_972_999 })
    ])
  })

  it('keeps the same name on two dwarfs, since duplicates are allowed', async () => {
    const { store } = open()
    await store.put(named())
    await store.put(named({ dwarfId: 'codex:thread-1', provider: 'codex' }))

    const names = await store.list()
    expect(names).toHaveLength(2)
    expect(names.map((name) => name.customName)).toEqual(['Stonebeard', 'Stonebeard'])
  })

  it('forgets one dwarf’s name and leaves the others standing', async () => {
    const { store } = open()
    await store.put(named())
    await store.put(named({ dwarfId: 'codex:thread-1', provider: 'codex' }))

    await store.remove('claude:session-1:agent-9')

    await expect(store.list()).resolves.toEqual([
      named({ dwarfId: 'codex:thread-1', provider: 'codex' })
    ])
  })

  it('forgets a name it never held without complaining', async () => {
    await expect(open().store.remove('claude:nobody')).resolves.toBeUndefined()
  })

  it('keeps the name of a dwarf this panel holds, under the panel observer', async () => {
    const { store } = open()
    await store.put(named({ dwarfId: 'hosted:1', provider: 'panel' }))

    await expect(store.list()).resolves.toEqual([named({ dwarfId: 'hosted:1', provider: 'panel' })])
  })

  /*
   * A row this build would not have written costs that row and no more. The file is the user's,
   * and a name edited in by hand, or written by a build with other rules, is never shown as if
   * this build had cleaned it: main re-validates what it reads as it re-validates what it writes.
   */
  it('drops a row whose name this build would not have saved', async () => {
    const { store, database } = open()
    const db = await database.connect()
    for (const [dwarfId, customName] of [
      ['claude:a', ''],
      ['claude:b', '  padded  '],
      ['claude:c', 'Gimli 😀'],
      ['claude:d', 'x'.repeat(25)]
    ] as const) {
      db.run(
        'INSERT INTO dwarf_names (dwarf_id, provider, custom_name, set_at) VALUES (?, ?, ?, ?)',
        [dwarfId, 'claude', customName, 1]
      )
    }

    await expect(store.list()).resolves.toEqual([])
  })

  it('drops a row whose observer or time this build cannot read', async () => {
    const { store, database } = open()
    const db = await database.connect()
    db.run(
      'INSERT INTO dwarf_names (dwarf_id, provider, custom_name, set_at) VALUES (?, ?, ?, ?)',
      ['gemini:x', 'gemini', 'Stonebeard', 1]
    )
    db.run(
      'INSERT INTO dwarf_names (dwarf_id, provider, custom_name, set_at) VALUES (?, ?, ?, ?)',
      ['claude:x', 'claude', 'Stonebeard', 0]
    )

    await expect(store.list()).resolves.toEqual([])
  })

  /*
   * The error contract every tenant of this database keeps: a file that will not open has not
   * said nobody renamed anything, so list() rejects and the caller decides what that means.
   */
  it('refuses rather than answering "no names" when the database will not open', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')

    await expect(open(sqlite).store.list()).rejects.toThrow()
    await expect(open(sqlite).store.put(named())).rejects.toThrow()
  })
})

/*
 * The store a simulated valley uses, and the one a database that will not open falls back to:
 * names for this run only, never written anywhere (handoff, "Dwarf names in the app").
 */
describe('the dwarf names kept in memory (#635)', () => {
  it('holds a name for the life of the store and forgets it on reset', async () => {
    const store = createMemoryDwarfNameStore()
    await store.put(named())
    await expect(store.list()).resolves.toEqual([named()])

    await store.remove('claude:session-1:agent-9')
    await expect(store.list()).resolves.toEqual([])
  })

  it('shares nothing between two stores, so a second run starts with no names', async () => {
    await createMemoryDwarfNameStore().put(named())

    await expect(createMemoryDwarfNameStore().list()).resolves.toEqual([])
  })
})

/*
 * NAMES-QUESTIONS 1 and 2: a row saved under the earlier rule. Every name that rule saved was
 * already trimmed, collapsed and at most 24 characters, so the new order reads it back unchanged;
 * only a name holding a format character or a Hangul filler is no longer one this build would
 * save, and is dropped like any other row it would not have written.
 */
describe('the dwarf names on disk — rows from the earlier rule (#635)', () => {
  it('reads back a name the earlier rule saved, and drops one holding a format character', async () => {
    const { store, database } = open()
    const db = await database.connect()
    for (const [dwarfId, customName] of [
      ['claude:a', 'a'.repeat(22)],
      ['claude:b', 'Stone beard'],
      ['claude:c', 'Gim\u200Bli']
    ] as const) {
      db.run(
        'INSERT INTO dwarf_names (dwarf_id, provider, custom_name, set_at) VALUES (?, ?, ?, ?)',
        [dwarfId, 'claude', customName, 1]
      )
    }

    const names = await store.list()
    expect(names.map((name) => name.customName).sort()).toEqual(['Stone beard', 'a'.repeat(22)])
  })
})
