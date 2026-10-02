// The packaged `host-manifest.json` (ADR-002 D5; the packaged-layout piece of ISSUE-270, built ahead of it
// for the cut builds): electron-builder's afterPack step (scripts/build/afterPack.mjs) writes it into the
// resources folder of the packed app, which is where the packaged UI reads it (hostManifestPathOf:
// `process.resourcesPath`). It describes the directory the Host's versioned copy is made from (copySourceOf):
// the packed output folder on Windows and Linux, the `.app` bundle inside it on macOS. The manifest sits inside
// that directory, so it leaves its own path out, exactly as the launcher's check does (versionedCopy.ts).
//
// afterPack writes it after every step that changes the app's files before signing (the SDK runtime prune);
// on Windows afterSign writes it again, since electron-builder's signing step edits the executable
// (scripts/build/afterSign.mjs). A signed macOS bundle is ISSUE-270's (SP-03): nothing may be added to it
// after signing. verify-packaged-host-manifest.mjs fails any build whose manifest no longer matches its app.
//
// Plain Node: the TypeScript modules it imports use Node built-ins only, and Node 24 strips their types.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { packagedResourcesRelativeOf } from '../../src/ui-main/hostLauncher/copySource.ts'
import {
  buildManifest,
  HOST_MANIFEST_FILE,
  parseManifest,
  serializeManifest,
  verifyManifest
} from '../../src/ui-main/hostLauncher/hostManifest.ts'

/**
 * The copy source of the app electron-builder packed into `appOutDir`, and its platform: the folder itself, or
 * the `<productFilename>.app` bundle in it on macOS (copySourceOf names the same directories from the
 * executable's path at run time).
 */
export function packedCopySourceOf(context) {
  const platform = platformOf(context.electronPlatformName)
  const sourceDir =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir
  return { sourceDir, platform }
}

/**
 * Where a packed app keeps its manifest: in its resources folder, where the packaged app reads it
 * (hostManifestPathOf), as a path of this build host, which may package for another OS; and that
 * path relative to the copy source, with `/`.
 */
export function packagedManifestOf(sourceDir, platform) {
  const relative = `${packagedResourcesRelativeOf(sourceDir, platform)}/${HOST_MANIFEST_FILE}`
  return { manifestPath: path.join(sourceDir, ...relative.split('/')), relative }
}

/** Writes the manifest of the packed app at `sourceDir`; returns where, and how many entries it lists. */
export async function writePackagedHostManifest(sourceDir, platform) {
  const { manifestPath, relative } = packagedManifestOf(sourceDir, platform)
  const manifest = await buildManifest(sourceDir, { exclude: [relative] })
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8')
  return { manifestPath, entries: manifest.entries.length }
}

/**
 * Whether the packed app at `sourceDir` carries a manifest that matches it byte for byte, the check a fresh
 * versioned copy of it passes: `missing`, `invalid` (a file the launcher would refuse) or `mismatch`, which
 * names every differing entry (manifestDifferences).
 */
export async function verifyPackagedHostManifest(sourceDir, platform) {
  const { manifestPath, relative } = packagedManifestOf(sourceDir, platform)
  const text = await readFile(manifestPath, 'utf8').catch(() => null)
  if (text === null) return { ok: false, reason: 'missing' }
  const parsed = parseManifest(text)
  if (!parsed.ok) return { ok: false, reason: 'invalid' }
  const exclude = [relative]
  const check = await verifyManifest(sourceDir, parsed.value, { exclude })
  if (check.ok) return { ok: true }
  const actual = await buildManifest(sourceDir, { exclude }).catch(() => ({ entries: [] }))
  return {
    ok: false,
    reason: 'mismatch',
    differences: manifestDifferences(parsed.value.entries, actual.entries)
  }
}

/**
 * Every entry on which the manifest (`expected`) and the packed app (`actual`) differ, by path: `missing`
 * from the app, `extra` in it, or `changed` (another size, hash, link target or kind).
 */
export function manifestDifferences(expected, actual) {
  const found = new Map(actual.map((entry) => [entry.path, entry]))
  const differences = []
  for (const entry of expected) {
    const other = found.get(entry.path)
    found.delete(entry.path)
    if (other === undefined)
      differences.push({ path: entry.path, change: 'missing', expected: entry })
    else if (JSON.stringify(other) !== JSON.stringify(entry)) {
      differences.push({ path: entry.path, change: 'changed', expected: entry, actual: other })
    }
  }
  for (const entry of found.values())
    differences.push({ path: entry.path, change: 'extra', actual: entry })
  return differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** One difference as the check prints it. */
export function describeDifference(difference) {
  const { change, path: where, expected, actual } = difference
  if (change !== 'changed') return `${change} ${where}`
  if (expected.kind === 'file' && actual.kind === 'file') {
    return `changed ${where}: size ${expected.size} -> ${actual.size}, sha256 ${expected.sha256.slice(0, 12)} -> ${actual.sha256.slice(0, 12)}`
  }
  return `changed ${where}: ${describeEntry(expected)} -> ${describeEntry(actual)}`
}

function describeEntry(entry) {
  return entry.kind === 'file'
    ? `file of ${entry.size} bytes, sha256 ${entry.sha256.slice(0, 12)}`
    : `link to ${entry.target}`
}

/** electron-builder's afterPack step (called by scripts/build/afterPack.mjs, after the prune). */
export default async function writePackagedManifest(context) {
  const { sourceDir, platform } = packedCopySourceOf(context)
  const { entries } = await writePackagedHostManifest(sourceDir, platform)
  console.log(`[host-manifest] ${platform}: ${entries} entries`)
}

function platformOf(electronPlatformName) {
  if (electronPlatformName === 'win32' || electronPlatformName === 'linux') {
    return electronPlatformName
  }
  if (electronPlatformName === 'darwin') return 'darwin'
  // `mas` (Mac App Store) is not a target of this app; its layout is the .app's too, but fail loudly
  // rather than write a manifest for a layout nobody checked.
  throw new Error(`host-manifest: no packaged layout for platform ${electronPlatformName}`)
}
