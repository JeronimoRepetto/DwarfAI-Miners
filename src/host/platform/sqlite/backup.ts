// The pre-migration backup (09 §6.2 step 5, §8.3; ADR-005 item 6; 13 FM-099, FM-105).
//
// Before pending migrations run on a non-empty database, the runner calls this step. It writes
// `VACUUM INTO` a consistent copy named `<db file>.bak-v<from>-<stamp>`, `<stamp>` being the Clock's
// instant in a filesystem-safe, sortable UTC form (`20250615T150740000Z`). Then every backup of
// that database file except the three newest (by stamp) is deleted; no other file is touched.
// Each copy is `0600` on POSIX from its first byte (09 §9; ADR-017 item 6; 18 C-24).
import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import type { Result } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { DB_FILE_MODE } from './fileProtection'
import type { BackupStep } from './migrations/types'

export interface VacuumIntoBackupDeps {
  clock: Clock
  log: DiagnosticsLog
}

/** `2025-06-15T15:07:40.000Z` → `20250615T150740000Z`: no `:` or `.`, sorts as time does. */
export function fileStamp(instant: number): string {
  return new Date(instant).toISOString().replace(/[-:.]/g, '')
}

/** A copy being written carries this suffix until it is complete; it is never a backup. */
const PARTIAL = '.partial'

/** How many backups of one database file are kept (ADR-005 item 6). */
export const BACKUPS_KEPT = 3

const STAMP = String.raw`\d{8}T\d{9}Z`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface BackupFile {
  name: string
  version: number
  stamp: string
}

function backupPattern(dbName: string, suffix = ''): RegExp {
  return new RegExp(
    String.raw`^${escapeRegExp(dbName)}\.bak-v(\d+)-(${STAMP})${escapeRegExp(suffix)}$`
  )
}

/** The complete backups of the database file `dbName` in `dir`, newest first. */
function listBackups(dir: string, dbName: string): BackupFile[] {
  const pattern = backupPattern(dbName)
  return readdirSync(dir)
    .flatMap((name) => {
      const match = pattern.exec(name)
      return match === null ? [] : [{ name, version: Number(match[1]), stamp: String(match[2]) }]
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.version - a.version)
}

/** Copies an interrupted backup left behind (a crash or power loss mid-copy): never backups. */
function removeInterruptedCopies(dir: string, dbName: string): void {
  const pattern = backupPattern(dbName, PARTIAL)
  for (const name of readdirSync(dir)) {
    if (pattern.test(name)) rmSync(join(dir, name), { force: true })
  }
}

function sqlString(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** The code a failed backup is logged with: `SQLITE_*` or an errno name such as `ENOSPC`. */
function failureCode(error: unknown): string | null {
  if (error instanceof SqliteInfrastructureError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

export class VacuumIntoBackup implements BackupStep {
  constructor(private readonly deps: VacuumIntoBackupDeps) {}

  beforeMigrating(input: {
    db: SqliteDatabase
    path: string
    fromVersion: number
  }): Result<void, 'BACKUP_FAILED'> {
    const dir = dirname(input.path)
    const dbName = basename(input.path)
    const target = join(
      dir,
      `${dbName}.bak-v${input.fromVersion}-${fileStamp(this.deps.clock.now())}`
    )
    const partial = `${target}${PARTIAL}`
    try {
      removeInterruptedCopies(dir, dbName)
      if (existsSync(target)) {
        throw Object.assign(new Error('a backup with this name already exists'), { code: 'EEXIST' })
      }
      // The copy is created by the Host, empty and owner-only (09 §1, §9: backups `0600`), before
      // any byte of the database is in it; SQLite then writes into this file and keeps its mode,
      // instead of creating one with the process umask. The mode does nothing on Windows, where
      // the file inherits the data directory's per-user profile ACL.
      closeSync(openSync(partial, 'wx', DB_FILE_MODE))
      input.db.exec(`VACUUM INTO ${sqlString(partial)}`)
      renameSync(partial, target)
    } catch (error) {
      const errCode = failureCode(error)
      rmSync(partial, { force: true })
      if (errCode === null) throw error
      this.deps.log.record({
        level: 'error',
        event: 'db.backup',
        subsystem: 'host',
        outcome: 'failed',
        errCode
      })
      return { ok: false, error: 'BACKUP_FAILED' }
    }
    this.deps.log.record({ level: 'info', event: 'db.backup', subsystem: 'host', outcome: 'ok' })
    this.prune(dir, dbName)
    return { ok: true, value: undefined }
  }

  /** Keep the three newest. A backup that cannot be deleted stays: more copies, never fewer. */
  private prune(dir: string, dbName: string): void {
    for (const stale of listBackups(dir, dbName).slice(BACKUPS_KEPT)) {
      try {
        rmSync(join(dir, stale.name))
      } catch (error) {
        const errCode = failureCode(error)
        if (errCode === null) throw error
        this.deps.log.record({
          level: 'error',
          event: 'db.backup',
          subsystem: 'host',
          outcome: 'degraded',
          errCode
        })
      }
    }
  }
}
