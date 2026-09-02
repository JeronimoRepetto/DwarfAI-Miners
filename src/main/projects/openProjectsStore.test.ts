import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { APP_SCHEMA_VERSION } from '../appDatabase/appDatabase'
import { openProjectsStore } from './openProjectsStore'

const DB = 'C:\\userData\\projects-v1.db'

describe('openProjectsStore', () => {
  it('hands back a usable store when the database opens', async () => {
    const store = await openProjectsStore({
      filePath: DB,
      sqlite: new MemoryWritableSqlite(),
      platform: 'win32'
    })

    expect(store).not.toBeNull()
    const result = await store!.list()
    expect(result.ok && result.value).toEqual([])
  })

  it('answers null instead of throwing when the database will not open', async () => {
    // The panel's whole job is showing live sessions, and it must keep doing it
    // on a machine whose projects database is locked by another process.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')

    const store = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32' })

    expect(store).toBeNull()
  })

  it('states the reason exactly once, so a broken store is diagnosable', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')
    const warn = vi.fn()

    await openProjectsStore({ filePath: DB, sqlite, platform: 'win32', warn })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('corrupt')
  })

  it('refuses a database this build does not know the schema of', async () => {
    // The store refuses rather than discarding, and that refusal has to reach
    // the user as a panel with no declared mines, never as a failed launch.
    const sqlite = new MemoryWritableSqlite()
    const handle = await sqlite.open(DB)
    handle.exec(`PRAGMA user_version = ${APP_SCHEMA_VERSION + 1}`)
    handle.close()
    const warn = vi.fn()

    const store = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32', warn })

    expect(store).toBeNull()
    expect(warn.mock.calls[0]![0]).toContain('unsupported-schema')
  })

  it('probes the database rather than trusting that a handle came back', async () => {
    // A store is created lazily: without a read at startup, a corrupt file
    // would first be noticed by whichever poll happened to touch it.
    const sqlite = new MemoryWritableSqlite()
    const list = vi.spyOn(sqlite, 'open')

    await openProjectsStore({ filePath: DB, sqlite, platform: 'win32' })

    expect(list).toHaveBeenCalledWith(DB)
  })
})
