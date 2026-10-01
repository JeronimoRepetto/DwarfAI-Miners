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
// 3. Otherwise the app directory is copied into `host/<version>.tmp-<pid>`, verified against the
//    manifest byte for byte, the manifest is stored beside it, an outdated `host/<version>/` is
//    removed, and the temporary directory is renamed into place in one step. So the final
//    directory appears only by rename, never partially, and a copy that fails its check is removed
//    and never renamed.
//
// The copy source is the directory holding the executable (Windows, Linux) or the whole `.app`
// bundle (macOS), copied with symbolic links kept as links (SP-03: the bundle keeps its signature
// state as a byte copy). On macOS the bundle keeps its name inside the version folder, so the
// executable's path inside the copy is `host/<version>/<Name>.app/Contents/MacOS/<Name>`.
//
// Each outcome is logged as `versioned-copy` (19 §9.1, proc `ui`): outcome, cause class (`copy`,
// `reuse`), error code and duration, never a path.
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UiLog, UiLogEntry } from '../diagnostics/uiLogger'
import {
  checkManifestPresence,
  HOST_MANIFEST_FILE,
  parseManifest,
  verifyManifest,
  type HostManifest
} from './hostManifest'
import type { CopyPlatform } from './copySource'
import type { LauncherClock } from './ports'

export { copySourceOf, type CopyPlatform } from './copySource'
// The per-OS copy root (ADR-002 D5): one rule, shared with the Host through contracts (ISSUE-032).
export { versionedCopyRoot } from '@dwarfai/contracts'

/** The file operations that change the copy root; the Node ones in production, faulty ones in tests. */
export interface CopyOps {
  /** Copies the directory `from` to `to` (which must not exist), links kept as links. */
  copyTree(from: string, to: string): Promise<void>
  /** Renames in one step; `to` must not exist. */
  rename(from: string, to: string): Promise<void>
  /** Removes the directory and everything under it; a missing one is a success. */
  removeTree(target: string): Promise<void>
}

export const nodeCopyOps: CopyOps = {
  copyTree: (from, to) =>
    cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false
    }),
  rename: (from, to) => rename(from, to),
  removeTree: (target) => rm(target, { recursive: true, force: true, maxRetries: 2 })
}

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
      await request.ops.copyTree(request.sourceDir, contentIn(temp))
    } catch (error) {
      await request.ops.removeTree(temp).catch(() => undefined)
      return fail(`COPY_${errnoOf(error)}`)
    }
    const check = await verifyManifest(contentIn(temp), manifest, { exclude })
    if (!check.ok) {
      await request.ops.removeTree(temp).catch(() => undefined)
      return fail('MANIFEST_MISMATCH')
    }
    await writeFile(path.join(temp, HOST_MANIFEST_FILE), manifestText, 'utf8')
    // An outdated copy of this version (another build, or a damaged one) goes only now, so a copy
    // that fails above never costs the one already there.
    if (await exists(copyDir)) await request.ops.removeTree(copyDir)
    await request.ops.rename(temp, copyDir)
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
