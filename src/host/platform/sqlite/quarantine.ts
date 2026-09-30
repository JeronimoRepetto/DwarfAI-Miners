// Quarantine of an unreadable Host database (09 §8.3; ADR-015 item 6, L-01; 13 FM-103).
//
// A database file that SQLite reports `SQLITE_CORRUPT` or `SQLITE_NOTADB` while it is being opened
// is never treated as empty and never deleted: it is renamed `<db file>.corrupt-<stamp>`, with its
// companions (`-wal`, `-shm`, `-journal`) renamed alongside so the set stays openable together, and
// `db.quarantined` is logged with the SQLite code. The runner then starts on a fresh file.
//
// Either every present file moves or none does: when a rename fails, the files already moved are
// put back, and the open is refused, because a fresh database must never be created beside a
// leftover `-wal` or `-journal` of the old one.
import { existsSync, renameSync } from 'node:fs'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import type { Result } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import { fileStamp } from './backup'

/** The SQLite results that mean the file cannot be read as a database (09 §8.3). */
const UNREADABLE = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])

/** Suffixes SQLite gives the files that belong to a database file. */
const COMPANIONS = ['', '-wal', '-shm', '-journal'] as const

export function isUnreadableDatabaseError(error: unknown): error is SqliteInfrastructureError {
  return error instanceof SqliteInfrastructureError && UNREADABLE.has(error.code)
}

export interface QuarantineDeps {
  clock: Clock
  log: DiagnosticsLog
  /** The rename used for each file; `fs.renameSync` by default (a failing one in tests). */
  rename?: (from: string, to: string) => void
}

/** The first `<path>.corrupt-<stamp>[-n]` under which no file of the set exists yet. */
function freeTarget(path: string, stamp: string): string {
  for (let n = 0; ; n++) {
    const target = `${path}.corrupt-${stamp}${n === 0 ? '' : `-${n}`}`
    if (COMPANIONS.every((suffix) => !existsSync(`${target}${suffix}`))) return target
  }
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Move the unreadable database at `path` and its companions aside. `cause` is the SQLite error
 * that made it unreadable. Returns the quarantined path, or `QUARANTINE_FAILED` with every file
 * back in place.
 */
export function quarantineUnreadableDb(
  path: string,
  cause: SqliteInfrastructureError,
  deps: QuarantineDeps
): Result<{ quarantinedAs: string }, 'QUARANTINE_FAILED'> {
  const rename = deps.rename ?? renameSync
  const target = freeTarget(path, fileStamp(deps.clock.now()))
  const moved: string[] = []
  for (const suffix of COMPANIONS) {
    if (!existsSync(`${path}${suffix}`)) continue
    try {
      rename(`${path}${suffix}`, `${target}${suffix}`)
      moved.push(suffix)
    } catch (error) {
      for (const back of moved.reverse()) rename(`${target}${back}`, `${path}${back}`)
      deps.log.record({
        level: 'error',
        event: 'db.quarantined',
        subsystem: 'host',
        outcome: 'failed',
        errCode: errnoCode(error) ?? cause.code
      })
      return { ok: false, error: 'QUARANTINE_FAILED' }
    }
  }
  deps.log.record({
    level: 'error',
    event: 'db.quarantined',
    subsystem: 'host',
    errCode: cause.code
  })
  return { ok: true, value: { quarantinedAs: target } }
}
