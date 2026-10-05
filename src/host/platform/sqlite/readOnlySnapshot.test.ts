// layer: L3
// L3 (17 §1.3) over real SQLite files in a per-test temp dir (17 §5.3): the read-only snapshot of a
// foreign database (15 §5; 13 FM-090; 18 T-30; lead decision 2026-09-30 in ISSUE-073), with a live
// writer standing in for the provider (Codex `state_5.sqlite`, OpenCode `opencode.db`).
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import { isRetryNextCycle, openReadOnlySnapshot } from './readOnlySnapshot'
import { otherWriterCanTakeWriteLock } from './testing/otherWriter'

const temps: string[] = []
const open: DatabaseSync[] = []
afterEach(async () => {
  for (const db of open.splice(0)) if (db.isOpen) db.close()
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dwarfai-snapshot-'))
  temps.push(dir)
  return dir
}

/** The provider: a WAL database whose commits stay in the WAL (no checkpoint moves them). */
function liveWriter(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 0 })
  open.push(db)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)')
  db.exec("INSERT INTO threads VALUES ('t1', '/work/a')")
  // t1 is in the main file; t2 is committed to the WAL only.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec("INSERT INTO threads VALUES ('t2', '/work/b')")
  return db
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

describe('openReadOnlySnapshot', () => {
  it('[FM-090] a read-only snapshot of a database being written never writes, never uses immutable, and a busy file is retried next cycle', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state_5.sqlite')
    const writer = liveWriter(path)
    const mainBefore = await digest(path)
    const walBefore = await digest(`${path}-wal`)

    const snapshot = await openReadOnlySnapshot(path)
    expect(snapshot.kind).toBe('open')
    if (snapshot.kind !== 'open') return
    // The committed WAL frames are merged: `immutable` would see an empty main file instead.
    expect(snapshot.reader.all('SELECT id FROM threads ORDER BY id')).toEqual([
      { id: 't1' },
      { id: 't2' }
    ])
    expect(snapshot.reader.all('PRAGMA query_only')).toEqual([{ query_only: 1 }])
    expect(() => snapshot.reader.all("INSERT INTO threads VALUES ('t3', '/work/c')")).toThrow(
      SqliteInfrastructureError
    )
    // The provider is never locked out of writing while the snapshot is open …
    const probe = new DatabaseSync(path, { timeout: 0 })
    open.push(probe)
    expect(otherWriterCanTakeWriteLock(probe)).toBe(true)
    probe.close()
    // … and the snapshot keeps the state it opened on.
    writer.exec("INSERT INTO threads VALUES ('t3', '/work/c')")
    expect(snapshot.reader.all('SELECT count(*) AS n FROM threads')).toEqual([{ n: 2 }])
    snapshot.reader.close()

    // The reader wrote nothing: the main file is the provider's, and the WAL holds only the
    // provider's own new commit.
    expect(await digest(path)).toBe(mainBefore)
    expect(await digest(`${path}-wal`)).not.toBe(walBefore)
    const walAfterWrite = await digest(`${path}-wal`)
    const second = await openReadOnlySnapshot(path)
    if (second.kind !== 'open') throw new Error(`expected an open snapshot, got ${second.kind}`)
    expect(second.reader.all('SELECT count(*) AS n FROM threads')).toEqual([{ n: 3 }])
    second.reader.close()
    expect(await digest(`${path}-wal`)).toBe(walAfterWrite)
    expect(await digest(path)).toBe(mainBefore)

    // With no provider running there is no WAL: the snapshot creates no file beside the database.
    writer.close()
    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['state_5.sqlite'])
    const resting = await digest(path)
    const closed = await openReadOnlySnapshot(path)
    if (closed.kind !== 'open') throw new Error(`expected an open snapshot, got ${closed.kind}`)
    expect(closed.reader.all('SELECT count(*) AS n FROM threads')).toEqual([{ n: 3 }])
    closed.reader.close()
    expect((await readdir(dir)).sort()).toEqual(files)
    expect(await digest(path)).toBe(resting)

    // A provider holding its file exclusively: busy, a typed retry for the next cycle.
    const lockedPath = join(dir, 'locked.sqlite')
    const exclusive = new DatabaseSync(lockedPath, { timeout: 0 })
    open.push(exclusive)
    exclusive.exec('PRAGMA journal_mode = WAL; PRAGMA locking_mode = EXCLUSIVE')
    exclusive.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
    expect(await openReadOnlySnapshot(lockedPath)).toEqual({
      kind: 'retry-next-cycle',
      code: 'SQLITE_BUSY'
    })
    expect(
      isRetryNextCycle(new SqliteInfrastructureError('SQLITE_BUSY', 5, 'database is locked'))
    ).toBe(true)
    expect(
      isRetryNextCycle(new SqliteInfrastructureError('SQLITE_ERROR', 1, 'no such table'))
    ).toBe(false)

    // A file that is not there is unavailable, not an error.
    expect((await openReadOnlySnapshot(join(dir, 'absent.sqlite'))).kind).toBe('unavailable')
  })
})
