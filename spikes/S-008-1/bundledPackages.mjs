#!/usr/bin/env node
// Spike S-008-1, release-artifact half (ADR-008 item 1; `20` §2.4, §2.5, R-06; ISSUE-328 TC-328-02): the packages
// each packed app really ships, read from its `app.asar` and `app.asar.unpacked/`, joined with the licence report of
// the lockfile (scripts/release/licenses.mjs) and the S-008-1 rows (scripts/release/s008-records.mjs).
//
//   node spikes/S-008-1/bundledPackages.mjs --root <artifact or extracted dir> [--root ...] --out <dir>
//
// For every bundled package and version: its licence and verdict in the licence report, whether S-008-1 governs it
// (a provider adapter or library, or the keyring library), and its S-008-1 row state. It also lists the packages the
// artifacts ship that the licence report does not know (drift between lockfile and artifact). Writes
// `<out>/S-008-1-bundled.json` and `<out>/S-008-1-bundled.md` (the table the S-008-1 record takes its rows from).
// Exits 1 when no app was found, when a governed package has no passed row, or when a bundled package is missing from
// the licence report. Reads files only.
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asarHeaderLength,
  bundledPackageJsons,
  listAsarFiles,
  parseAsarHeader
} from '../../scripts/release/packaged/asar.mjs'
import { buildLicenceReport, DENIED_FILE, readDenied } from '../../scripts/release/licenses.mjs'
import { checkS008Records, inS008Scope, readS008Rows } from '../../scripts/release/s008-records.mjs'
import {
  environmentFacts,
  findPackedApps,
  list,
  options,
  scrub,
  writeEvidence
} from '../_packaged/kit.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readRange(fd, start, length) {
  const buffer = Buffer.alloc(length)
  readSync(fd, buffer, 0, length, start)
  return buffer
}

/** `{ name, version }` of every package manifest packed in an app's asar or unpacked beside it. */
export function packagesOfApp(asarFile) {
  const found = new Map()
  const add = (manifest) => {
    if (manifest?.name && manifest?.version) {
      found.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version
      })
    }
  }
  const fd = openSync(asarFile, 'r')
  try {
    const header = parseAsarHeader(readRange(fd, 0, asarHeaderLength(readRange(fd, 0, 16))))
    for (const file of listAsarFiles(header.header)) {
      // An unpacked file is read from disk below: the header may still list one the afterPack prune removed.
      if (file.unpacked || bundledPackageJsons([file.path]).length === 0) continue
      add(JSON.parse(readRange(fd, header.dataOffset + file.offset, file.size).toString('utf8')))
    }
  } finally {
    closeSync(fd)
  }
  const unpacked = path.join(`${asarFile}.unpacked`, 'node_modules')
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.startsWith('@')) walk(full)
      else if (existsSync(path.join(full, 'package.json'))) {
        add(JSON.parse(readFileSync(path.join(full, 'package.json'), 'utf8')))
        walk(path.join(full, 'node_modules'))
      }
    }
  }
  walk(unpacked)
  return [...found.values()]
}

function main() {
  const args = options(process.argv.slice(2))
  const roots = list(args.root)
  if (roots.length === 0 || !args.out) {
    console.error('usage: bundledPackages.mjs --root <dir> [--root <dir>] --out <dir>')
    return 2
  }
  const report = buildLicenceReport({
    rootDir: REPO,
    denied: readDenied(path.join(REPO, DENIED_FILE))
  })
  const byKey = new Map(report.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]))
  const rows = readS008Rows(REPO)
  const apps = roots.flatMap((root) => findPackedApps(root))
  const bundled = new Map()
  for (const app of apps) {
    for (const pkg of packagesOfApp(app.asar)) {
      const key = `${pkg.name}@${pkg.version}`
      const entry = bundled.get(key) ?? { ...pkg, apps: [] }
      entry.apps.push(path.basename(app.appDir))
      bundled.set(key, entry)
    }
  }
  const packages = [...bundled.values()].sort((a, b) => a.name.localeCompare(b.name))
  const records = checkS008Records({ packages, rows })
  const table = packages.map((pkg) => {
    const licensed = byKey.get(`${pkg.name}@${pkg.version}`)
    const governed = inS008Scope(pkg.name, rows)
    const row = rows.find((r) => r.name === pkg.name && r.version === pkg.version)
    return {
      name: pkg.name,
      version: pkg.version,
      licence: licensed?.license ?? null,
      verdict: licensed?.verdict ?? 'not in the licence report',
      s008: governed
        ? row
          ? row.compatible && row.bundle
            ? 'passed'
            : 'not passed'
          : 'no row'
        : 'not governed',
      apps: [...new Set(pkg.apps)]
    }
  })
  const notInReport = table
    .filter((row) => row.licence === null)
    .map((row) => `${row.name}@${row.version}`)
  writeEvidence(args.out, 'S-008-1-bundled', {
    spike: 'S-008-1',
    environment: environmentFacts(),
    apps: apps.map((app) => path.basename(app.appDir)),
    packages: table,
    s008Failures: records.failures,
    notInLicenceReport: notInReport
  })
  const md = [
    '| Package | Version | Licence | Licence verdict | S-008-1 |',
    '| --- | --- | --- | --- | --- |',
    ...table.map(
      (row) =>
        `| \`${row.name}\` | ${row.version} | ${row.licence ?? '-'} | ${row.verdict} | ${row.s008} |`
    )
  ].join('\n')
  writeFileSync(path.join(args.out, 'S-008-1-bundled.md'), `${scrub(md)}\n`)
  console.log(
    `S-008-1: ${apps.length} app(s), ${table.length} bundled packages, ${records.checked.length} governed by S-008-1`
  )
  for (const failure of records.failures) console.error(`FAIL ${failure}`)
  for (const key of notInReport) console.error(`FAIL ${key}: shipped but not in the licence report`)
  if (apps.length === 0) return 1
  return records.failures.length === 0 && notInReport.length === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
