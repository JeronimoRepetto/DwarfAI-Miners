#!/usr/bin/env node
/**
 * trace:check (testing strategy `17` §3.1, §3.2): the ratchet that keeps every requirement id
 * mapped to a test as issues close.
 *
 * It compares `traceability.json` (written by `extract.mjs` from the test titles) with the id
 * catalogs and the two append-only lists beside this script, and fails on:
 *
 * 1. an id cited by a test that no catalog holds (a typo), printed with the file and title;
 *    `MAN-<area>-<nn>` ids are accepted only when `manual.json` (`20` §8.1) lists them;
 * 2. an AC of `closed.json` (the primary AC ids each issue's PR appends when it closes) that no
 *    test cites;
 * 3. an id of `mapped.baseline.json` (ids already mapped) that no test cites any more.
 *
 * Catalogs (OQ-83): the architecture package lives only on the owner's machine. When it is present
 * (`new-architecture/DwarfAI-Miners-Architecture/`, or the path given with `--from`), the catalogs
 * are rebuilt from it into the git-ignored `scripts/traceability/catalogs/` first, so they are
 * never stale; otherwise the catalogs already there are used. Where neither the package nor the
 * catalogs exist (remote CI), check 1 is skipped with the notice "architecture package not present:
 * catalog check skipped" and checks 2 and 3, which read only tracked repository files, still run.
 * A `--from` path that does not exist fails, and so does an incomplete catalogs folder.
 *
 * Usage: node scripts/traceability/check.mjs [--from <package dir>] [--root <repository root>]
 *   (`pnpm trace:check` runs the extractor first, then this check.)
 * Exit code 0 when every check passes, 1 with one line per failure on stderr.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATALOGS_PATH,
  CATALOG_NAMES,
  CatalogError,
  PACKAGE_PATH,
  buildCatalogs
} from './build-catalogs.mjs'

export const SKIP_NOTICE = 'architecture package not present: catalog check skipped'

class TraceCheckError extends Error {}

function readJson(file, label) {
  if (!existsSync(file)) throw new TraceCheckError(`${label} not found: ${file}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new TraceCheckError(`${label} is not valid JSON: ${error.message}`)
  }
}

/** An append-only id list (`closed.json`, `mapped.baseline.json`): a JSON array of strings. */
function readIdList(file, label) {
  const list = readJson(file, label)
  if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id !== '')) {
    throw new TraceCheckError(`${label} must be a JSON array of id strings`)
  }
  return list
}

function readTraceability(file) {
  const map = readJson(file, 'traceability.json (run extract.mjs first)')
  const valid =
    map !== null &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    Object.values(map).every((entries) => Array.isArray(entries))
  if (!valid) throw new TraceCheckError('traceability.json must map each id to a list of tests')
  return map
}

/**
 * The catalogs in `dir` as `{ revision, known }`, or null when the folder holds none of them.
 * A folder that holds only some catalogs, or catalogs of different revisions, fails.
 */
export function loadCatalogs(dir) {
  const present = existsSync(dir) ? new Set(readdirSync(dir)) : new Set()
  const files = CATALOG_NAMES.map((name) => `${name}.json`)
  if (!files.some((file) => present.has(file))) return null
  const missing = files.filter((file) => !present.has(file))
  if (missing.length > 0) {
    throw new TraceCheckError(
      `catalogs incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from ${dir}; run build-catalogs.mjs`
    )
  }
  const known = new Set()
  const revisions = new Set()
  for (const file of files) {
    const catalog = readJson(path.join(dir, file), file)
    const ids = Array.isArray(catalog?.ids) ? catalog.ids : Object.keys(catalog?.ids ?? {})
    if (typeof catalog?.revision !== 'string' || catalog.revision === '') {
      throw new TraceCheckError(`${file} does not name the package revision it was read from`)
    }
    revisions.add(catalog.revision)
    for (const id of ids) known.add(id)
  }
  if (revisions.size !== 1) {
    throw new TraceCheckError(
      `catalogs mix package revisions (${[...revisions].sort().join(', ')}); run build-catalogs.mjs`
    )
  }
  return { revision: [...revisions][0], known }
}

/**
 * The catalogs to check against: rebuilt from the package when it is present (`from`, else the
 * default location under `root`), else the ones already built, else null.
 */
export function resolveCatalogs({ root, from }) {
  const catalogsDir = path.join(root, ...CATALOGS_PATH)
  if (from !== undefined && !existsSync(from)) {
    throw new TraceCheckError(`--from path does not exist: ${from}`)
  }
  const packageDir = path.resolve(from ?? path.join(root, ...PACKAGE_PATH))
  if (existsSync(packageDir)) buildCatalogs(packageDir, catalogsDir)
  return loadCatalogs(catalogsDir)
}

/** Every failure of the three checks, as printable lines, in a stable order. */
export function findFailures({ traceability, known, closed, baseline }) {
  const failures = []
  if (known) {
    for (const [id, entries] of Object.entries(traceability)) {
      if (known.has(id)) continue
      for (const { file, title } of entries) failures.push(`${file} › ${title}: unknown id ${id}`)
    }
  }
  const tested = (id) => (traceability[id]?.length ?? 0) > 0
  for (const id of closed) {
    if (!tested(id)) failures.push(`closed.json: ${id} has no test`)
  }
  for (const id of baseline) {
    if (!tested(id)) failures.push(`mapped.baseline.json: ${id} lost its last test`)
  }
  return failures
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new TraceCheckError(`${name} needs a value`)
  return value
}

/** Runs the check as the command line does; returns the exit code. */
export function runTraceCheck(argv, io) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const root = path.resolve(optionValue(argv, '--root') ?? path.join(here, '..', '..'))
    const from = optionValue(argv, '--from')
    const listDir = path.join(root, 'scripts', 'traceability')
    const traceability = readTraceability(path.join(root, 'traceability.json'))
    const closed = readIdList(path.join(listDir, 'closed.json'), 'closed.json')
    const baseline = readIdList(path.join(listDir, 'mapped.baseline.json'), 'mapped.baseline.json')
    const catalogs = resolveCatalogs({ root, from })
    io.out(catalogs ? `catalog check: package revision ${catalogs.revision}` : SKIP_NOTICE)

    const failures = findFailures({ traceability, known: catalogs?.known, closed, baseline })
    for (const failure of failures) io.err(failure)
    if (failures.length > 0) {
      io.err(`trace:check: ${failures.length} failure(s)`)
      return 1
    }
    io.out(
      `trace:check: ok (${Object.keys(traceability).length} mapped id(s), ${closed.length} closed AC(s), ${baseline.length} baseline id(s))`
    )
    return 0
  } catch (error) {
    if (!(error instanceof TraceCheckError || error instanceof CatalogError)) throw error
    io.err(`trace:check: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTraceCheck(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
