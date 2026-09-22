import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { APP_SCHEMA_VERSION } from '../appDatabase/appDatabase'
import { openProjectsStore } from './openProjectsStore'

const DB = 'C:\\userData\\projects-v1.db'

describe('openProjectsStore', () => {
  it('hands back a usable store when the database opens', async () => {
    const opened = await openProjectsStore({
      filePath: DB,
      sqlite: new MemoryWritableSqlite(),
      platform: 'win32'
    })

    expect(opened.store).not.toBeNull()
    expect(opened.failure).toBeNull()
    const result = await opened.store!.list()
    expect(result.ok && result.value).toEqual([])
  })

  it('answers a null store instead of throwing when the database will not open', async () => {
    // The panel's whole job is showing live sessions, and it must keep doing it
    // on a machine whose projects database is locked by another process.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')

    const opened = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32' })

    expect(opened.store).toBeNull()
    // AMENDED for #572: the failure now travels alongside the null store
    // rather than dying in the warn log, so a caller two layers up (the
    // runtime's refusal sites) can tell "locked" from "a newer build wrote
    // this file" without re-parsing a message string.
    expect(opened.failure).toBe('locked')
  })

  it('states the reason exactly once, so a broken store is diagnosable', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')
    const warn = vi.fn()

    const opened = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32', warn })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('corrupt')
    expect(opened.failure).toBe('corrupt')
  })

  // AMENDED for #572: this fixture (a stamp above APP_SCHEMA_VERSION) is
  // specifically the NEWER-build case, which the classifier now reports as
  // 'newer-build' rather than the generic 'unsupported-schema' — see the two
  // tests below for why the two refusals had to split.
  it('refuses a database written by a newer build, distinctly from an unrecognised one', async () => {
    // The store refuses rather than discarding, and that refusal has to reach
    // the user as a panel with no declared mines, never as a failed launch.
    const sqlite = new MemoryWritableSqlite()
    const handle = await sqlite.open(DB)
    handle.exec(`PRAGMA user_version = ${APP_SCHEMA_VERSION + 1}`)
    handle.close()
    const warn = vi.fn()

    const opened = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32', warn })

    expect(opened.store).toBeNull()
    expect(opened.failure).toBe('newer-build')
    expect(warn.mock.calls[0]![0]).toContain('newer-build')
  })

  it('keeps an unstamped projects table as unsupported-schema, not newer-build', async () => {
    // No PRAGMA user_version at all (defaults to 0) with a projects table
    // already standing: this build did not write it and will not guess at a
    // version for it, which is not the same refusal as a stamp it recognises
    // but has outgrown.
    const sqlite = new MemoryWritableSqlite()
    const handle = await sqlite.open(DB)
    handle.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
    handle.close()
    const warn = vi.fn()

    const opened = await openProjectsStore({ filePath: DB, sqlite, platform: 'win32', warn })

    expect(opened.store).toBeNull()
    expect(opened.failure).toBe('unsupported-schema')
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
