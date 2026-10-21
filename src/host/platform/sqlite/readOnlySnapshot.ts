// The read-only snapshot of a FOREIGN SQLite file (15 §5; 13 FM-090; 18 T-30; 09 §1 "DwarfAI
// reads, never writes"): Codex `state_5.sqlite`, OpenCode `opencode.db`, Antigravity's
// conversations databases. Lead decision 2026-09-30 (ISSUE-073): it lives here, with `node:sqlite`
// (05 R11), and answers the kernel `SqliteDatabase` read side (`SqliteReader`, no new port method);
// the Host's own database is `NodeSqliteDatabase`'s.
//
// - The file is opened `mode=ro` with `PRAGMA query_only = ON` (read back), never `immutable`:
//   SQLite then merges the frames the provider committed to its WAL, which `immutable` would
//   ignore (a stale or empty view, and no locking at all on a file that is being written).
// - One read transaction is opened at once, so every query of the snapshot sees the same commit.
//   A reader never takes the write lock: the provider keeps writing while it is open.
// - No busy wait: a file the provider holds exclusively (`SQLITE_BUSY`, `SQLITE_LOCKED`) answers a
//   typed `retry-next-cycle`, and the caller reads it at its next poll. A query that meets the
//   same codes later throws `SqliteInfrastructureError`; `isRetryNextCycle` tells it apart.
// - A WAL-mode database with no `-wal` beside it has no provider writing it, and opening it, even
//   read-only, would create `-wal` and `-shm` files in the provider's folder. Its bytes are then
//   complete in the main file, so the snapshot reads a private copy instead and the provider's
//   folder is left exactly as it was. A `-journal` beside the file is a rollback-mode commit in
//   flight: retry next cycle.
// - The private copy is removed before `close` returns (and on every failure path), never by a
//   removal left running behind the caller: that one raced the next read's copy and, when the
//   file was still held (Windows), rejected with nobody to catch it. A copy that cannot be
//   removed is left in the temp folder rather than failing the read.
//
// Nothing the file holds is logged (ADR-026 item 4).
import { rmSync } from 'node:fs'
import { access, copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import type { SqliteReader, SqliteRow } from '../../kernel/ports/sqliteDatabase'
import { toInfrastructureError } from './NodeSqliteDatabase'

/** The SQLite codes a snapshot meets when the provider holds its file: read it next cycle. */
const RETRY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

export type ReadOnlySnapshot =
  | { kind: 'open'; reader: SqliteReader }
  /** The provider holds the file now; nothing was read, nothing is lost. */
  | { kind: 'retry-next-cycle'; code: 'SQLITE_BUSY' | 'SQLITE_LOCKED' | 'hot-journal' }
  /** Missing, not a database, or unreadable: the `SQLITE_*` code, `not-found` or `copy-failed`. */
  | { kind: 'unavailable'; code: string }

/** How an adapter opens a snapshot (injected by the composition root; tests pass the real one). */
export type ReadOnlySnapshotOpener = (location: string) => Promise<ReadOnlySnapshot>

/** Whether an error a snapshot query threw means "the provider holds the file: next cycle". */
export function isRetryNextCycle(error: unknown): boolean {
  return error instanceof SqliteInfrastructureError && RETRY_CODES.has(error.code)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Opens a consistent, read-only snapshot of the SQLite file at `location`. Never throws.
 * `copyRoot` is where a private copy is made (the OS temp folder; tests pass their own).
 */
export async function openReadOnlySnapshot(
  location: string,
  copyRoot: string = tmpdir()
): Promise<ReadOnlySnapshot> {
  if (!(await exists(location))) return { kind: 'unavailable', code: 'not-found' }
  if (await exists(`${location}-journal`)) return { kind: 'retry-next-cycle', code: 'hot-journal' }
  if (await exists(`${location}-wal`)) return openAt(location, null)

  // No provider is writing: read a private copy, so nothing appears beside the provider's file.
  let dir: string
  try {
    dir = await mkdtemp(join(copyRoot, 'dwarfai-foreign-db-'))
  } catch {
    return { kind: 'unavailable', code: 'copy-failed' }
  }
  const cleanup = () => removeQuietly(dir)
  try {
    const copy = join(dir, 'snapshot.sqlite')
    await copyFile(location, copy)
    // The provider started while the file was copied: the copy may be torn, read it next cycle.
    if ((await exists(`${location}-wal`)) || (await exists(`${location}-journal`))) {
      cleanup()
      return { kind: 'retry-next-cycle', code: 'SQLITE_BUSY' }
    }
    const snapshot = openAt(copy, cleanup)
    if (snapshot.kind !== 'open') cleanup()
    return snapshot
  } catch {
    cleanup()
    return { kind: 'unavailable', code: 'copy-failed' }
  }
}

/** Removes a private copy's folder now; a folder still held is left behind, never thrown. */
function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Still held (Windows): the temp folder keeps it; the read itself is unaffected.
  }
}

function openAt(location: string, onClose: (() => void) | null): ReadOnlySnapshot {
  const uri = pathToFileURL(location)
  uri.searchParams.set('mode', 'ro')
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(uri, { readOnly: true, timeout: 0 })
    db.exec('PRAGMA query_only = ON')
    const readBack = db.prepare('PRAGMA query_only').get() as { query_only?: unknown } | undefined
    if (readBack?.query_only !== 1) throw new Error('PRAGMA query_only did not read back ON')
    // Pin one commit for every query of the snapshot; the first read takes it.
    db.exec('BEGIN')
    db.prepare('SELECT count(*) FROM sqlite_schema').get()
  } catch (error) {
    if (db?.isOpen === true) db.close()
    const mapped = toInfrastructureError(error)
    if (mapped instanceof SqliteInfrastructureError) {
      return RETRY_CODES.has(mapped.code)
        ? { kind: 'retry-next-cycle', code: mapped.code as 'SQLITE_BUSY' | 'SQLITE_LOCKED' }
        : { kind: 'unavailable', code: mapped.code }
    }
    return { kind: 'unavailable', code: 'SQLITE_ERROR' }
  }
  const open = db
  return {
    kind: 'open',
    reader: {
      all: (sql, params = []) => {
        try {
          return open.prepare(sql).all(...params) as SqliteRow[]
        } catch (error) {
          throw toInfrastructureError(error)
        }
      },
      close: () => {
        if (!open.isOpen) return
        try {
          open.exec('COMMIT')
        } catch {
          // Nothing to commit on a read transaction that already ended; closing ends it anyway.
        }
        open.close()
        if (onClose !== null) onClose()
      }
    }
  }
}
