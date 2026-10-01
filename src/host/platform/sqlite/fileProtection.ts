// File protection of the Host's data at rest (09 §1, §9; ADR-017 item 6; 18 C-24, T-36).
//
// Protection is per OS user, like every desktop app (ADR-017 item 6); secrets never live in these
// files (ADR-017 items 1–5), and nothing is encrypted at rest in v1 (09 §9).
//
// - POSIX: `protectDataDir` creates `hostDataDir` with mode `0700`, or narrows the mode it finds to
//   `0700`. `protectDbFiles` sets `0600` on the database file and its family beside it: `-wal`,
//   `-shm`, `-journal`, every `.bak-*` backup (09 §8.3) and every `.corrupt-*` quarantined copy
//   (09 §8.3, a renamed database holds the same data). A mode found looser is narrowed and logged
//   once per call (`db.file-mode`, `count` = paths narrowed); paths and modes are never logged.
//   A symbolic link or any other non-regular entry named like a database file is never followed and
//   never changed (`lstat`).
// - Windows: Node ignores modes for ACLs. The data directory sits in the per-user profile
//   (`%APPDATA%`) and its files keep the ACL they inherit from it (09 §1, §9, architect-decided);
//   a stricter DACL is not asked for (ISSUE-041 scope). Only the directory is created.
//
// A failing call (a `chmod` refused, a directory that cannot be created) throws: the boot step
// fails with its code rather than opening the data with a mode it could not narrow.
//
// This is the only place that branches on the OS for these files (R18).
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'

/** `hostDataDir` on POSIX (09 §1). */
export const DATA_DIR_MODE = 0o700
/** The database, its companions, backups and quarantined copies on POSIX (09 §1, §9). */
export const DB_FILE_MODE = 0o600

/** What the protection reads of one path: its kind and permission bits, never following a link. */
export interface FileModeInfo {
  kind: 'dir' | 'file' | 'other'
  /** The permission bits (`mode & 0o777`). */
  mode: number
}

/** The file operations the protection needs; `nodeFileModes` in production, a fake in L1. */
export interface FileModes {
  /** The entry at `path` as `lstat` sees it, or null when there is none. */
  inspect(path: string): Promise<FileModeInfo | null>
  chmod(path: string, mode: number): Promise<void>
  /** Creates the directory and any missing parent with `mode`; an existing one is a success. */
  makeDir(path: string, mode: number): Promise<void>
  /** The names in `dir`. */
  list(dir: string): Promise<string[]>
}

export interface FileProtectionDeps {
  log: DiagnosticsLog
  /** `process.platform` by default. */
  platform?: NodeJS.Platform
  /** `nodeFileModes` by default. */
  files?: FileModes
}

/** The real file operations over `node:fs`. */
export const nodeFileModes: FileModes = {
  async inspect(path) {
    try {
      const stats = await lstat(path)
      const kind = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other'
      return { kind, mode: stats.mode & 0o777 }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
      throw error
    }
  },
  chmod: (path, mode) => chmod(path, mode),
  async makeDir(path, mode) {
    await mkdir(path, { recursive: true, mode })
  },
  list: (dir) => readdir(dir)
}

const REPAIRED_MSG = 'a looser mode was found and narrowed'

function logRepair(log: DiagnosticsLog, causeClass: 'data-dir' | 'db-file', count: number): void {
  if (count === 0) return
  log.record({
    level: 'warn',
    event: 'db.file-mode',
    subsystem: 'host',
    causeClass,
    outcome: 'ok',
    count,
    msg: REPAIRED_MSG
  })
}

/** Creates `hostDataDir` owner-only, or narrows the mode it has (09 §1, §9). */
export async function protectDataDir(hostDataDir: string, deps: FileProtectionDeps): Promise<void> {
  const files = deps.files ?? nodeFileModes
  await files.makeDir(hostDataDir, DATA_DIR_MODE)
  if ((deps.platform ?? process.platform) === 'win32') return
  const found = await files.inspect(hostDataDir)
  if (found?.kind !== 'dir' || found.mode === DATA_DIR_MODE) return
  await files.chmod(hostDataDir, DATA_DIR_MODE)
  logRepair(deps.log, 'data-dir', 1)
}

/** True for the database file `dbName` and the files SQLite and the Host keep beside it. */
function isDbFamily(name: string, dbName: string): boolean {
  return (
    name === dbName ||
    name === `${dbName}-wal` ||
    name === `${dbName}-shm` ||
    name === `${dbName}-journal` ||
    name.startsWith(`${dbName}.bak-`) ||
    name.startsWith(`${dbName}.corrupt-`)
  )
}

/** Sets `0600` on the database at `dbPath`, its companions, backups and quarantined copies. */
export async function protectDbFiles(dbPath: string, deps: FileProtectionDeps): Promise<void> {
  if ((deps.platform ?? process.platform) === 'win32') return
  const files = deps.files ?? nodeFileModes
  const dir = dirname(dbPath)
  const dbName = basename(dbPath)
  let repaired = 0
  for (const name of await files.list(dir)) {
    if (!isDbFamily(name, dbName)) continue
    const path = join(dir, name)
    const found = await files.inspect(path)
    if (found?.kind !== 'file' || found.mode === DB_FILE_MODE) continue
    await files.chmod(path, DB_FILE_MODE)
    repaired++
  }
  logRepair(deps.log, 'db-file', repaired)
}
