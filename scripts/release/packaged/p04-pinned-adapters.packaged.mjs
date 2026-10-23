// P-04 (`20` §2.3; ADR-008 item 1; `18` C-35; spike S-008-1; ISSUE-271): every bundled adapter or library is at its
// pinned version and has a closed S-008-1 record. The packages S-008-1 governs (`inS008Scope`: the ACP SDK, the
// keyring library and its per-platform binaries, and any package a row names) are read from the manifests of every
// packed app (the `node_modules` folders inside `app.asar` and in `app.asar.unpacked`). Each must be at the version of
// its S-008-1 row, which records GPL-3.0-or-later compatibility and the owner's decision to bundle it, and, when the
// app's own `package.json` lists it, at exactly that version (a range is not a pin). A folder with no packed app fails,
// so a broken build never passes. It reads files only.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { REPO_ROOT } from '../lockfile-provider-scan.mjs'
import { checkS008Records, inS008Scope, readS008Rows } from '../s008-records.mjs'
import { bundledPackageJsons } from './asar.mjs'
import { findAppAsars, openAsar, relativeTo } from './apps.mjs'

export const id = 'P-04'

/** Every `node_modules/**\/package.json` of an unpacked folder, as paths relative to it. */
async function unpackedManifests(dir) {
  const found = []
  async function walk(current, relative) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(current, entry.name), next)
      else if (entry.isFile()) found.push(next)
    }
  }
  await walk(dir, '')
  return bundledPackageJsons(found)
}

/** The packages bundled in one app: `{ name, version, where }`, from the archive and the unpacked folder. */
async function bundledPackages(asarFile, archive) {
  const manifests = bundledPackageJsons(archive.paths).map((file) => ({
    file,
    read: async () => archive.text(file)
  }))
  const unpacked = `${asarFile}.unpacked`
  for (const file of await unpackedManifests(unpacked)) {
    manifests.push({ file, read: () => readFile(path.join(unpacked, ...file.split('/')), 'utf8') })
  }
  const packages = []
  for (const { file, read } of manifests) {
    try {
      const { name, version } = JSON.parse(await read())
      if (typeof name === 'string' && typeof version === 'string') packages.push({ name, version })
    } catch {
      // Not a package manifest (a template, a fixture): it names no bundled package.
    }
  }
  return packages
}

export default async function check({ artifactDir, rows = readS008Rows(REPO_ROOT) }) {
  const asars = await findAppAsars(artifactDir)
  if (asars.length === 0) return { ok: false, detail: `no packed app (app.asar) in ${artifactDir}` }
  const failures = []
  const passed = new Set()
  for (const file of asars) {
    const archive = await openAsar(file)
    const where = relativeTo(artifactDir, file)
    const pins = archive.paths.includes('package.json')
      ? (JSON.parse(archive.text('package.json')).dependencies ?? {})
      : {}
    const governed = (await bundledPackages(file, archive)).filter(({ name }) =>
      inS008Scope(name, rows)
    )
    const { failures: recordFailures } = checkS008Records({ packages: governed, rows })
    for (const failure of recordFailures) failures.push(`${where}: ${failure}`)
    for (const { name, version } of governed) {
      const pin = pins[name]
      if (pin !== undefined && pin !== version) {
        failures.push(`${where}: ${name}@${version} differs from its pinned ${pin}`)
      }
      if (!recordFailures.some((failure) => failure.startsWith(`${name}@${version}:`))) {
        passed.add(`${name}@${version}`)
      }
    }
  }
  if (failures.length > 0) return { ok: false, detail: failures.join('; ') }
  const list = [...passed].sort()
  return {
    ok: true,
    detail:
      list.length === 0
        ? `${asars.length} packed apps bundle no package S-008-1 governs`
        : `${asars.length} packed apps bundle ${list.length} packages at their pinned version with a closed S-008-1 record: ${list.join(', ')}`
  }
}
