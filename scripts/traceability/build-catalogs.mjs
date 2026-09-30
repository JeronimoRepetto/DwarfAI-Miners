#!/usr/bin/env node
/**
 * Id catalogs for trace:check (testing strategy `17` §3.2, revised 2026-09-30, OQ-83).
 *
 * Reads the architecture package, which lives only on the owner's machine at
 * `new-architecture/DwarfAI-Miners-Architecture/` (git-ignored, never pushed), and writes one JSON
 * catalog per id family under the git-ignored `scripts/traceability/catalogs/`. Each file records
 * the package revision it was read from (the package is under its own local git; `-dirty` is
 * appended when a tracked package file has uncommitted changes). The output depends only on the
 * package content, so two runs on one revision write identical bytes. Nothing of the package is
 * ever written to a tracked path. Re-run whenever the package's `02`, `06`, `07` or `15` changes;
 * `check.mjs` also rebuilds the catalogs itself whenever the package is present.
 *
 * Each catalog reads its ids exactly as the owner document spells them (`17` §2.2 accepted ids;
 * `24-issues/README.md` §7):
 *
 * | Catalog            | Owner and where the ids are defined                                          |
 * | ------------------ | ---------------------------------------------------------------------------- |
 * | `acs.json`         | `02`, generated story catalog after `<!-- CATALOG -->`: id → story, tag       |
 * | `nfrs.json`        | `02` §4 table rows                                                           |
 * | `brs.json`         | `02` §5 table rows                                                           |
 * | `invs.json`        | `06` invariant bullets `**INV-nn**`                                          |
 * | `transitions.json` | `07` transition table rows `S<machine>.<nn>`                                 |
 * | `conformance.json` | `15` §6 table rows `C-nn`                                                    |
 * | `fms.json`         | `13` failure-mode table rows `FM-nnn`                                        |
 * | `chs.json`         | `17` §1.10 injector table rows `CH-nn`                                       |
 * | `spikes.json`      | `03-adr/spike-register.md` rows `SP-nn` / `S-0nn-n`, aliases included        |
 * | `rules.json`       | `05` §5.1 rule table rows `R<n>`                                             |
 * | `adrs.json`        | `03-adr/ADR-0nn-*.md` decision files                                         |
 * | `manual.json`      | `20` §8.1 manual check rows `MAN-<area>-<nn>`                                |
 *
 * A section or marker that cannot be found fails the build: a catalog is never silently empty.
 *
 * Usage: node scripts/traceability/build-catalogs.mjs [--from <package dir>] [--out <dir>]
 *   Without `--from`, the package is read from `new-architecture/DwarfAI-Miners-Architecture/` and,
 *   where it is absent, the build is skipped with a notice. A `--from` path that does not exist
 *   fails.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CATALOG_NAMES = [
  'acs',
  'nfrs',
  'brs',
  'invs',
  'transitions',
  'conformance',
  'fms',
  'chs',
  'spikes',
  'rules',
  'adrs',
  'manual'
]

/** Where the package lives inside the repository (`00-README.md` "Location", OQ-83). */
export const PACKAGE_PATH = ['new-architecture', 'DwarfAI-Miners-Architecture']
export const CATALOGS_PATH = ['scripts', 'traceability', 'catalogs']

const CATALOG_MARKER = '<!-- CATALOG -->'
const AC_LINE = /^- \*\*(US-[A-Z]+-\d{3})\.(AC\d{2})\*\* `(happy|edge|error)`/
const NFR_ROW = /^\|\s*(NFR-[A-Z0-9]+-\d{2})\s*\|/
const BR_ROW = /^\|\s*(BR-\d{2})\s*\|/
const INV_BULLET = /^\s*- \*\*(INV-\d+)\*\*/
const TRANSITION_ROW = /^\|\s*(S\d+\.[BC]?\d+[a-z]?)\s*\|/
const CONFORMANCE_ROW = /^\|\s*(C-\d{2}[a-z]?)[\s|]/
const FM_ROW = /^\|\s*(FM-\d{3})\s*\|/
const CH_ROW = /^\|\s*(CH-\d{2})\s*\|/
const SPIKE_ROW = /^\|\s*((?:SP-\d{2}|S-\d{3}-\d)\b[^|]*)\|/
const SPIKE_ID = /\b(?:SP-\d{2}|S-\d{3}-\d)\b/g
const RULE_ROW = /^\|\s*(R\d{1,2})\s*\|/
const ADR_FILE = /^(ADR-\d{3})-.+\.md$/
const MANUAL_ROW = /^\|\s*`?(MAN-[A-Z][A-Z0-9]*-\d{2})`?\s*\|/

class CatalogError extends Error {}

function readLines(packageDir, file) {
  const full = path.join(packageDir, ...file.split('/'))
  if (!existsSync(full)) throw new CatalogError(`${file} is missing from the package`)
  return readFileSync(full, 'utf8').split(/\r?\n/)
}

/**
 * The lines of the section that starts at the heading matching `start`, up to the next heading of
 * the same or a higher level. Fails when the heading is absent.
 */
function section(lines, file, start) {
  const from = lines.findIndex((line) => start.test(line))
  if (from === -1) throw new CatalogError(`${file}: section ${start} not found`)
  const level = /^#+/.exec(lines[from])[0].length
  const next = lines.findIndex(
    (line, index) => index > from && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level
  )
  return lines.slice(from + 1, next === -1 ? undefined : next)
}

/** The first capture of `pattern` on every line that matches it, sorted and unique. */
function idsOf(lines, pattern) {
  return sortedUnique(lines.map((line) => pattern.exec(line)?.[1]).filter(Boolean))
}

function sortedUnique(ids) {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function nonEmpty(ids, what) {
  if (ids.length === 0) throw new CatalogError(`${what}: no id found`)
  return ids
}

const READERS = {
  acs: [
    '02-requirements.md',
    (lines, file) => {
      const marker = lines.indexOf(CATALOG_MARKER)
      if (marker === -1) throw new CatalogError(`${file}: ${CATALOG_MARKER} marker not found`)
      const acs = {}
      for (const line of lines.slice(marker + 1)) {
        const ac = AC_LINE.exec(line)
        if (ac) acs[`${ac[1]}.${ac[2]}`] = { story: ac[1], tag: ac[3] }
      }
      const ids = nonEmpty(sortedUnique(Object.keys(acs)), `${file} story catalog`)
      return Object.fromEntries(ids.map((id) => [id, acs[id]]))
    }
  ],
  nfrs: [
    '02-requirements.md',
    (lines, file) => nonEmpty(idsOf(section(lines, file, /^## 4\. /), NFR_ROW), `${file} §4`)
  ],
  brs: [
    '02-requirements.md',
    (lines, file) => nonEmpty(idsOf(section(lines, file, /^## 5\. /), BR_ROW), `${file} §5`)
  ],
  invs: ['06-domain-model.md', (lines, file) => nonEmpty(idsOf(lines, INV_BULLET), file)],
  transitions: [
    '07-state-machines.md',
    (lines, file) => nonEmpty(idsOf(lines, TRANSITION_ROW), file)
  ],
  conformance: [
    '15-provider-driver.md',
    (lines, file) =>
      nonEmpty(idsOf(section(lines, file, /^## 6\. /), CONFORMANCE_ROW), `${file} §6`)
  ],
  fms: ['13-failure-matrix.md', (lines, file) => nonEmpty(idsOf(lines, FM_ROW), file)],
  chs: [
    '17-testing-strategy.md',
    (lines, file) => nonEmpty(idsOf(section(lines, file, /^### 1\.10 /), CH_ROW), `${file} §1.10`)
  ],
  spikes: [
    '03-adr/spike-register.md',
    (lines, file) =>
      nonEmpty(
        sortedUnique(
          lines.flatMap((line) => {
            const firstCell = SPIKE_ROW.exec(line)?.[1]
            return firstCell ? firstCell.match(SPIKE_ID) : []
          })
        ),
        file
      )
  ],
  rules: [
    '05-modules-and-ports.md',
    (lines, file) => nonEmpty(idsOf(section(lines, file, /^### 5\.1 /), RULE_ROW), `${file} §5.1`)
  ],
  // The manual check table starts empty and grows as issues close (`20` §8.1): an empty list is
  // valid, a missing section is not.
  manual: [
    '20-build-release.md',
    (lines, file) => idsOf(section(lines, file, /^### 8\.1 /), MANUAL_ROW)
  ]
}

/** The ADR ids of the decision files in `03-adr/`. */
function readAdrs(packageDir) {
  const dir = path.join(packageDir, '03-adr')
  if (!existsSync(dir)) throw new CatalogError('03-adr is missing from the package')
  const ids = readdirSync(dir)
    .map((name) => ADR_FILE.exec(name)?.[1])
    .filter(Boolean)
  return nonEmpty(sortedUnique(ids), '03-adr')
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function samePath(a, b) {
  const [left, right] = [realpathSync.native(a), realpathSync.native(b)]
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** The package's own git revision; `-dirty` when a tracked file has uncommitted changes. */
export function packageRevision(packageDir) {
  let topLevel
  try {
    topLevel = git(packageDir, ['rev-parse', '--show-toplevel'])
  } catch {
    topLevel = null
  }
  if (topLevel === null || !samePath(topLevel, packageDir)) {
    throw new CatalogError(
      `${packageDir} is not the root of its own git repository, so its revision cannot be recorded`
    )
  }
  const head = git(packageDir, ['rev-parse', 'HEAD'])
  const dirty = git(packageDir, ['status', '--porcelain', '--untracked-files=no']) !== ''
  return dirty ? `${head}-dirty` : head
}

/** Every catalog of the package at `packageDir`, as `{ name → { catalog, source, revision, ids } }`. */
export function readCatalogs(packageDir) {
  const revision = packageRevision(packageDir)
  const catalogs = {}
  for (const name of CATALOG_NAMES) {
    if (name === 'adrs') {
      catalogs[name] = { catalog: name, source: '03-adr', revision, ids: readAdrs(packageDir) }
      continue
    }
    const [source, read] = READERS[name]
    const ids = read(readLines(packageDir, source), source)
    catalogs[name] = { catalog: name, source, revision, ids }
  }
  return catalogs
}

/** Reads the package at `packageDir` and writes its catalogs under `outDir`; returns the revision. */
export function buildCatalogs(packageDir, outDir) {
  const catalogs = readCatalogs(packageDir)
  mkdirSync(outDir, { recursive: true })
  for (const name of CATALOG_NAMES) {
    writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(catalogs[name], null, 2)}\n`)
  }
  return catalogs[CATALOG_NAMES[0]].revision
}

export { CatalogError }

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new CatalogError(`${name} needs a value`)
  return value
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..', '..')
  const from = optionValue(argv, '--from')
  const out = path.resolve(optionValue(argv, '--out') ?? path.join(root, ...CATALOGS_PATH))
  if (from !== undefined && !existsSync(from)) {
    throw new CatalogError(`--from path does not exist: ${from}`)
  }
  const packageDir = path.resolve(from ?? path.join(root, ...PACKAGE_PATH))
  if (!existsSync(packageDir)) {
    process.stdout.write('architecture package not present: catalog build skipped\n')
    return
  }
  const revision = buildCatalogs(packageDir, out)
  process.stdout.write(`catalogs: package revision ${revision} → ${out}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error
    process.stderr.write(`build-catalogs: ${error.message}\n`)
    process.exitCode = 1
  }
}
