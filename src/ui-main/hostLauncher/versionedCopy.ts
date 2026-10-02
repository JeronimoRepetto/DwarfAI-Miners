// The Host's versioned copy (ADR-002 D5; ADR-027 item 2; 13 FM-129; SP-03 decision table): the
// Host never runs from the package manager's install folder, a portable extraction or an AppImage
// mount. The launcher runs ensureVersionedCopy with the spawn gate held, right before it starts the
// Host (UC-002), so no other launcher copies at the same time and no Host is starting:
//
// 1. Every `*.tmp-*` directory under the root is a leftover (a copy or a removal killed mid-way,
//    FM-129) and is removed first.
// 2. `host/<version>/` is reused when it was verified against the same build manifest (the
//    manifest stored in it has the same SHA-256 as this build's) and every listed file is still
//    there with its size (checkManifestPresence: no re-hash on every start, SP-03).
// 3. Otherwise the app directory's listed entries are copied into `host/<version>.tmp-<pid>`
//    (a file an installer added beside the app is not part of it), verified against the manifest
//    byte for byte, the manifest is stored beside it, an outdated `host/<version>/` is
//    renamed aside (never deleted in place: one a running Host holds fails the start
//    `COPY_IN_USE`), and the temporary directory is renamed into place in one step. So the final
//    directory appears only by rename, never partially, and a copy that fails at any step is
//    removed and never renamed.
//
// The copy source is the directory holding the executable (Windows, Linux) or the whole `.app`
// bundle (macOS), copied with symbolic links kept as links (SP-03: the bundle keeps its signature
// state as a byte copy). On macOS the bundle keeps its name inside the version folder, so the
// executable's path inside the copy is `host/<version>/<Name>.app/Contents/MacOS/<Name>`.
//
// Each outcome is logged as `versioned-copy` (19 §9.1, proc `ui`): outcome, cause class (`copy`,
// `reuse`), error code and duration, never a path.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { UiLog, UiLogEntry } from '../diagnostics/uiLogger'
import { plainFs } from './plainFs'
import {
  checkManifestPresence,
  HOST_MANIFEST_FILE,
  parseManifest,
  verifyManifest,
  type HostManifest
} from './hostManifest'
import type { CopyPlatform } from './copySource'
import type { LauncherClock } from './ports'

// Without Electron's asar layer: the copied folder holds an `.asar` archive (plainFs.ts).
const { cp, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } = plainFs.promises

export {
  copySourceOf,
  hostManifestPathOf,
  packagedResourcesDirOf,
  type CopyPlatform
} from './copySource'
// The per-OS copy root (ADR-002 D5): one rule, shared with the Host through contracts (ISSUE-032).
export { versionedCopyRoot } from '@dwarfai/contracts'

/** The file operations that change the copy root; the Node ones in production, faulty ones in tests. */
export interface CopyOps {
  /**
   * Copies the directory `from` to `to` (which must not exist), links kept as links. With `include`,
   * only the entries whose relative path (with `/`) it accepts are copied, and a folder is entered
   * only when it accepts the folder's path.
   */
  copyTree(from: string, to: string, include?: (relativePath: string) => boolean): Promise<void>
  /** Renames in one step; `to` must not exist. */
  rename(from: string, to: string): Promise<void>
  /** Removes the directory and everything under it; a missing one is a success. */
  removeTree(target: string): Promise<void>
  /**
   * The error code of the first file under the directory that a running process holds (it cannot be opened for
   * writing: EBUSY on Windows, ETXTBSY on Linux), or null when none is held.
   */
  busyFile(dir: string): Promise<string | null>
}

export const nodeCopyOps: CopyOps = {
  copyTree: (from, to, include) =>
    cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
      ...(include === undefined
        ? {}
        : {
            filter: (source: string) => {
              const relative = path.relative(from, source)
              return relative === '' || include(relative.split(path.sep).join('/'))
            }
          })
    }),
  rename: (from, to) => rename(from, to),
  removeTree: (target) => rm(target, { recursive: true, force: true, maxRetries: 2 }),
  async busyFile(dir) {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        await (await open(path.join(entry.parentPath, entry.name), 'r+')).close()
      } catch (error) {
        const code = errnoOf(error)
        if (BUSY_CODES.has(code)) return code
      }
    }
    return null
  }
}

/**
 * What opening a file for writing gets while a running process executes it: EBUSY on Windows (a running image), ETXTBSY
 * on Linux. Any other error (a read-only file, say) is not a sign of use. macOS gives no such error.
 */
const BUSY_CODES = new Set(['EBUSY', 'ETXTBSY'])

export interface VersionedCopyRequest {
  /** The app version: the copy's folder name. */
  version: string
  /** The app directory copied (copySourceOf). */
  sourceDir: string
  /** This build's `host-manifest.json`, describing `sourceDir`. */
  manifestPath: string
  /** The per-OS `host/` folder (versionedCopyRoot). */
  root: string
  platform: CopyPlatform
  /** The UI process's pid: the temporary directory's suffix. */
  pid: number
  ops: CopyOps
  log: UiLog
  clock: LauncherClock
}

export type VersionedCopyOutcome =
  | {
      ok: true
      reused: boolean
      /** `host/<version>/`. */
      copyDir: string
      /** Where the copied app directory is: `copyDir`, or `copyDir/<Name>.app` on macOS. */
      contentDir: string
    }
  | { ok: false; errCode: string }

/** Marks a directory under the root as a leftover to remove at the next start. */
export const TEMP_MARKER = '.tmp-'

const EVENT = 'versioned-copy'
const SUBSYSTEM = 'host-launcher'

export async function ensureVersionedCopy(
  request: VersionedCopyRequest
): Promise<VersionedCopyOutcome> {
  const startedAt = request.clock.now()
  const record = (entry: Omit<UiLogEntry, 'event' | 'subsystem'>): void =>
    request.log.record({ ...entry, event: EVENT, subsystem: SUBSYSTEM })
  const fail = (errCode: string): VersionedCopyOutcome => {
    record({
      level: 'error',
      outcome: 'failed',
      causeClass: 'copy',
      errCode,
      durationMs: request.clock.now() - startedAt
    })
    return { ok: false, errCode }
  }

  if (!isVersionFolderName(request.version)) return fail('VERSION_INVALID')
  const manifestText = await readFile(request.manifestPath, 'utf8').catch(() => null)
  if (manifestText === null) return fail('MANIFEST_MISSING')
  const parsed = parseManifest(manifestText)
  if (!parsed.ok) return fail('MANIFEST_INVALID')
  const manifest = parsed.value

  const copyDir = path.join(request.root, request.version)
  const bundle = request.platform === 'darwin' ? bundleNameOf(request.sourceDir) : null
  const contentIn = (dir: string): string => (bundle === null ? dir : path.join(dir, bundle))
  const exclude = excludedPaths(request.sourceDir, request.manifestPath)

  try {
    await mkdir(request.root, { recursive: true })
    await removeLeftovers(request.root, request.ops)

    if (await isVerifiedCopy(copyDir, contentIn(copyDir), manifestText, manifest)) {
      record({
        level: 'info',
        outcome: 'ok',
        causeClass: 'reuse',
        durationMs: request.clock.now() - startedAt
      })
      return { ok: true, reused: true, copyDir, contentDir: contentIn(copyDir) }
    }

    const temp = path.join(request.root, `${request.version}${TEMP_MARKER}${request.pid}`)
    try {
      await request.ops.copyTree(request.sourceDir, contentIn(temp), listedIn(manifest))
    } catch (error) {
      await request.ops.removeTree(temp).catch(() => undefined)
      return fail(`COPY_${errnoOf(error)}`)
    }
    const check = await verifyManifest(contentIn(temp), manifest, { exclude })
    if (!check.ok) {
      await request.ops.removeTree(temp).catch(() => undefined)
      return fail('MANIFEST_MISMATCH')
    }
    try {
      await writeFile(path.join(temp, HOST_MANIFEST_FILE), manifestText, 'utf8')
      const placed = await replaceByRename(request, temp, copyDir)
      if (!placed.ok) {
        await request.ops.removeTree(temp).catch(() => undefined)
        return fail(placed.errCode)
      }
    } catch (error) {
      await request.ops.removeTree(temp).catch(() => undefined)
      return fail(`COPY_${errnoOf(error)}`)
    }
  } catch (error) {
    return fail(`COPY_${errnoOf(error)}`)
  }
  record({
    level: 'info',
    outcome: 'ok',
    causeClass: 'copy',
    durationMs: request.clock.now() - startedAt
  })
  return { ok: true, reused: false, copyDir, contentDir: contentIn(copyDir) }
}

/** A version usable as one folder name under the root, and never mistaken for a leftover. */
function isVersionFolderName(version: string): boolean {
  return (
    /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) &&
    !version.includes('..') &&
    !version.includes(TEMP_MARKER)
  )
}

/**
 * Puts the verified `temp` at `copyDir`. An outdated copy there (another build of this version, or a damaged one) is
 * never deleted in place, and never while a running process holds one of its files (ADR-027 item 2: a copy used by a
 * running Host is not deleted). A held copy is left whole and the start fails `COPY_IN_USE`: on Windows the folder of
 * a running executable can still be renamed, but a removal would delete every file but the held ones
 * (versionedCopyInUse.os.test.ts). Otherwise it is renamed aside to `<version>.tmp-<pid>-old`, the new copy is renamed
 * into place, and what went aside is removed; should that removal fail, it is a `.tmp-` leftover, removed at the next
 * start.
 */
async function replaceByRename(
  request: VersionedCopyRequest,
  temp: string,
  copyDir: string
): Promise<{ ok: true } | { ok: false; errCode: string }> {
  if (!(await exists(copyDir))) {
    await request.ops.rename(temp, copyDir)
    return { ok: true }
  }
  if ((await request.ops.busyFile(copyDir)) !== null) return { ok: false, errCode: 'COPY_IN_USE' }
  const aside = path.join(request.root, `${request.version}${TEMP_MARKER}${request.pid}-old`)
  await request.ops.rename(copyDir, aside)
  await request.ops.rename(temp, copyDir)
  await request.ops.removeTree(aside).catch(() => undefined)
  return { ok: true }
}

async function removeLeftovers(root: string, ops: CopyOps): Promise<void> {
  for (const name of await readdir(root)) {
    if (name.includes(TEMP_MARKER)) await ops.removeTree(path.join(root, name))
  }
}

async function isVerifiedCopy(
  copyDir: string,
  contentDir: string,
  manifestText: string,
  manifest: HostManifest
): Promise<boolean> {
  const stored = await readFile(path.join(copyDir, HOST_MANIFEST_FILE), 'utf8').catch(() => null)
  if (stored === null || sha256(stored) !== sha256(manifestText)) return false
  return (await checkManifestPresence(contentDir, manifest)).ok
}

/**
 * The entries the copy takes from the source: the listed ones and the folders that hold them. A
 * file the installer adds beside the app after the build (the nsis uninstaller in the install
 * directory) is not part of the app and stays out, while a listed entry the source lacks still
 * fails the check of the copy.
 */
function listedIn(manifest: HostManifest): (relativePath: string) => boolean {
  const listed = new Set<string>()
  for (const entry of manifest.entries) {
    const parts = entry.path.split('/')
    for (let end = 1; end <= parts.length; end++) listed.add(parts.slice(0, end).join('/'))
  }
  return (relativePath) => listed.has(relativePath)
}

/** The manifest's own path, relative with `/`, when it lives inside the copied directory. */
function excludedPaths(sourceDir: string, manifestPath: string): string[] {
  const relative = path.relative(sourceDir, manifestPath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return []
  return [relative.split(path.sep).join('/')]
}

function bundleNameOf(sourceDir: string): string | null {
  const name = path.basename(sourceDir)
  return name.endsWith('.app') ? name : null
}

async function exists(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => null)) !== null
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** An OS error's code (`EBUSY`, `ENOSPC`, …) for the log, or `FAILED`. */
export function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'FAILED'
}
