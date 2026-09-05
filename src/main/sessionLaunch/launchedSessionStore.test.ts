import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase, type AppDatabase } from '../appDatabase/appDatabase'
import {
  createSqliteLaunchedSessionStore,
  type PersistedLaunch,
  type LaunchedSessionStore
} from './launchedSessionStore'

const DB = 'C:\\userData\\projects-v1.db'

function launch(overrides: Partial<PersistedLaunch> = {}): PersistedLaunch {
  return {
    launchId: 'launch:1',
    provider: 'codex',
    sessionId: 'thread-new',
    minePath: 'C:\\work\\project',
    pid: 4242,
    processStartTimeMs: 1_788_001_972_136,
    ...overrides
  }
}

function open(sqlite = new MemoryWritableSqlite()): {
  store: LaunchedSessionStore
  database: AppDatabase
  sqlite: MemoryWritableSqlite
} {
  const database = createAppDatabase({ filePath: DB, sqlite })
  return { store: createSqliteLaunchedSessionStore({ database }), database, sqlite }
}

describe('the launch register on disk (#231)', () => {
  it('has nothing to say about a machine that has launched nothing', async () => {
    const { store } = open()
    await expect(store.list()).resolves.toEqual([])
  })

  /*
   * The whole point of the file: a register written by one run of the app is
   * read by the next one. Two stores over one database stand in for the two
   * runs, exactly as the real thing reopens the same file.
   */
  it('hands a launch written by one run to the run after it', async () => {
    const sqlite = new MemoryWritableSqlite()
    await open(sqlite).store.put(launch())

    await expect(open(sqlite).store.list()).resolves.toEqual([launch()])
  })

  it('replaces a launch rather than duplicating it under one id', async () => {
    const { store } = open()
    await store.put(launch())
    await store.put(launch({ sessionId: 'thread-claimed-later' }))

    await expect(store.list()).resolves.toEqual([launch({ sessionId: 'thread-claimed-later' })])
  })

  it('forgets one launch and leaves the others standing', async () => {
    const { store } = open()
    await store.put(launch())
    await store.put(launch({ launchId: 'launch:2', pid: 99 }))

    await store.remove('launch:1')

    await expect(store.list()).resolves.toEqual([launch({ launchId: 'launch:2', pid: 99 })])
  })

  it('forgets a launch it never held without complaining', async () => {
    const { store } = open()
    await expect(store.remove('launch:nope')).resolves.toBeUndefined()
  })

  /*
   * A row this build cannot make sense of costs that row and no more — the
   * same suspicion readLedger applies to the vault's own rows, and for a
   * sharper reason here: every field is an ingredient of a decision to KILL a
   * process, so a half-read row must never become a whole one.
   */
  it('drops a row whose provider this build does not know', async () => {
    const { store, database } = open()
    const db = await database.connect()
    db.run(
      `INSERT INTO launched_sessions
       (launch_id, provider, session_id, mine_path, pid, proc_start_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['launch:9', 'gemini', 's', 'C:\\work\\project', 4242, 1_788_001_972_136]
    )

    await expect(store.list()).resolves.toEqual([])
  })

  it('drops a row whose pid or creation time is not a usable number', async () => {
    const { store, database } = open()
    const db = await database.connect()
    // 0 and a negative are the two pids buildEndProcessTreeCommand refuses
    // outright (kill -TERM -1 signals everything the user owns, and group 0 is
    // the panel's own), and a creation time of 0 is no evidence at all.
    for (const [launchId, pid, procStart] of [
      ['launch:8', 0, 1_788_001_972_136],
      ['launch:9', -1, 1_788_001_972_136],
      ['launch:10', 4242, 0]
    ] as const) {
      db.run(
        `INSERT INTO launched_sessions
         (launch_id, provider, session_id, mine_path, pid, proc_start_ms)
         VALUES (?, 'codex', 'thread', 'C:\\work\\project', ?, ?)`,
        [launchId, pid, procStart]
      )
    }

    await expect(store.list()).resolves.toEqual([])
  })

  /*
   * The error contract of every tenant of this database, and it matters more
   * here than for the vault: answering "nothing was launched" for a database
   * that would not open would silently retire an exit the user still has.
   */
  it('refuses rather than reporting an empty register when the database will not open', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')

    await expect(open(sqlite).store.list()).rejects.toThrow()
  })
})
