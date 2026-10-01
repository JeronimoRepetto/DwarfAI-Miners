// The build manifest of the app directory the Host's versioned copy is made from (ADR-002 D5:
// `host-manifest.json`, "file list + SHA-256"; lead decision 2026-09-30 in ISSUE-031): every file
// and symbolic link under the directory, by relative path with `/` separators, sorted by path. A
// file carries its size and SHA-256; a link carries its target verbatim (the macOS `.app` bundle
// holds links, and the copy keeps them as links, SP-03).
//
// - buildManifest(dir) writes it: scripts/build/write-host-manifest.mjs for development and test
//   builds, the packaging job for packaged ones (later: ISSUE-270, which reuses this function).
// - verifyManifest(dir, manifest) is the check of a fresh copy before its atomic rename: the copy
//   must hold exactly the listed entries with the listed bytes, nothing missing and nothing extra.
// - checkManifestPresence(dir, manifest) is the cheap check of a copy that is reused: every listed
//   entry still there with its size (a file an antivirus removed, a copy left half-deleted), no
//   hashing (SP-03: re-hashing costs 0.2–0.4 s on every start).
//
// Node built-ins only and erasable TypeScript only, so the plain-Node build script imports this
// file as it is (Node 24 strips the types).
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** The manifest's file name (ADR-002 D5). */
export const HOST_MANIFEST_FILE = 'host-manifest.json'

/** The one format this build reads and writes. */
export const HOST_MANIFEST_FORMAT = 1

export type HostManifestEntry =
  | { path: string; kind: 'file'; size: number; sha256: string }
  | { path: string; kind: 'symlink'; target: string }

export interface HostManifest {
  format: typeof HOST_MANIFEST_FORMAT
  entries: HostManifestEntry[]
}

export interface ManifestOptions {
  /** Relative paths (with `/`) left out: the manifest's own file when it lives inside the directory. */
  exclude?: readonly string[]
}

export type ManifestCheck = { ok: true } | { ok: false; reason: 'mismatch' }

/** Every file and link under `dir`, hashed. */
export async function buildManifest(
  dir: string,
  options: ManifestOptions = {}
): Promise<HostManifest> {
  const excluded = new Set(options.exclude ?? [])
  const entries: HostManifestEntry[] = []
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const name of await readdir(folder)) {
      const full = join(folder, name)
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (excluded.has(path)) continue
      const stats = await lstat(full)
      if (stats.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', target: await readlink(full) })
      } else if (stats.isDirectory()) {
        await walk(full, path)
      } else if (stats.isFile()) {
        entries.push({ path, kind: 'file', size: stats.size, sha256: await hashFile(full) })
      }
    }
  }
  await walk(dir, '')
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { format: HOST_MANIFEST_FORMAT, entries }
}

/** Whether `dir` holds exactly the manifest's entries, byte for byte. */
export async function verifyManifest(
  dir: string,
  manifest: HostManifest,
  options: ManifestOptions = {}
): Promise<ManifestCheck> {
  let actual: HostManifest
  try {
    actual = await buildManifest(dir, options)
  } catch {
    return { ok: false, reason: 'mismatch' }
  }
  return sameEntries(manifest.entries, actual.entries)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' }
}

/** Whether every listed entry is still under `dir`, a file with its size, a link with its target. */
export async function checkManifestPresence(
  dir: string,
  manifest: HostManifest
): Promise<ManifestCheck> {
  for (const entry of manifest.entries) {
    const full = join(dir, ...entry.path.split('/'))
    const stats = await lstat(full).catch(() => null)
    const present =
      stats !== null &&
      (entry.kind === 'file'
        ? stats.isFile() && stats.size === entry.size
        : stats.isSymbolicLink() && (await readlink(full).catch(() => null)) === entry.target)
    if (!present) return { ok: false, reason: 'mismatch' }
  }
  return { ok: true }
}

/** The manifest as its file holds it: stable JSON, one entry per line. */
export function serializeManifest(manifest: HostManifest): string {
  const lines = manifest.entries.map((entry) => `    ${JSON.stringify(entry)}`)
  return `{\n  "format": ${manifest.format},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`
}

/** The manifest a file holds, or `{ ok: false }` for anything this build does not accept. */
export function parseManifest(text: string): { ok: true; value: HostManifest } | { ok: false } {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false }
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['format', 'entries'])) return { ok: false }
  if (value['format'] !== HOST_MANIFEST_FORMAT || !Array.isArray(value['entries'])) {
    return { ok: false }
  }
  const entries: HostManifestEntry[] = []
  for (const raw of value['entries'] as unknown[]) {
    const entry = parseEntry(raw)
    if (entry === null) return { ok: false }
    entries.push(entry)
  }
  return { ok: true, value: { format: HOST_MANIFEST_FORMAT, entries } }
}

function parseEntry(raw: unknown): HostManifestEntry | null {
  if (!isRecord(raw) || !isSafeRelativePath(raw['path'])) return null
  const path = raw['path']
  if (raw['kind'] === 'file' && hasOnlyKeys(raw, ['path', 'kind', 'size', 'sha256'])) {
    const { size, sha256 } = raw
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
    return { path, kind: 'file', size, sha256 }
  }
  if (raw['kind'] === 'symlink' && hasOnlyKeys(raw, ['path', 'kind', 'target'])) {
    const { target } = raw
    if (typeof target !== 'string' || target === '') return null
    return { path, kind: 'symlink', target }
  }
  return null
}

/** A relative path with `/` separators that stays inside the directory. */
function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0')) {
    return false
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function sameEntries(a: readonly HostManifestEntry[], b: readonly HostManifestEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => sameEntry(entry, b[index]))
}

function sameEntry(a: HostManifestEntry, b: HostManifestEntry | undefined): boolean {
  if (b === undefined || a.path !== b.path) return false
  if (a.kind === 'file') return b.kind === 'file' && a.size === b.size && a.sha256 === b.sha256
  return b.kind === 'symlink' && a.target === b.target
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}
