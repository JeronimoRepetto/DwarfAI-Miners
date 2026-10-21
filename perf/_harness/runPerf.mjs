#!/usr/bin/env node
/**
 * The perf runner, `pnpm test:perf` (testing strategy `17` §1.11, L11).
 *
 * It discovers every `perf/**\/*.perf.ts` case under the repository root, runs them one after the
 * other in this process (never in parallel, so one case never loads the machine another measures)
 * and appends one record per case to `perf-results/<os>/<date>.json`:
 *
 *   { os, date, commit, case, samples }
 *
 * - `os` is `windows`, `macos` or `linux`; `date` is the UTC day (`YYYY-MM-DD`); `commit` is
 *   `GITHUB_SHA` in CI, else `git rev-parse HEAD`; `case` is the case file's repository-relative
 *   posix path; `samples` is what the case returned.
 * - A case is a module whose default export is a function (sync or async) returning its samples as
 *   an array of JSON values; see `perf/README.md`.
 * - No threshold is read or applied yet: a measured budget without a number is recorded without a
 *   gate until each OS has a baseline, which the lead then records in `17` §1.11. A slow sample never
 *   fails the run; a case that throws or returns something other than an array does.
 * - A case that measured and then failed a check throws an error carrying its `samples` array: its
 *   record keeps those samples and names the check in `failure`, the other cases still run and
 *   are recorded, and the run fails. A measurement is evidence even when a check beside it fails.
 * - A results file is a JSON array; a second run on the same day appends to it, never overwrites.
 * - A case may import the E2E harness (`e2e/_harness/`, `e2e/support/`, the fixture worlds), whose TypeScript imports
 *   some modules without their extension, as Playwright's loader allows. The command line therefore registers one
 *   resolve hook: a relative specifier with no extension that Node cannot find is tried again with `.ts`.
 *
 * Usage: node perf/_harness/runPerf.mjs [--root <repository root>] [--case <perf/…/name.perf.ts>]
 * `--case` runs that one case alone (its repository-relative posix path); a path that names no case fails the run.
 * Exit code 0 when every case ran (or there is none yet), 1 with the reason on stderr otherwise.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CASE_FILE = /\.perf\.ts$/
const SKIPPED_FOLDERS = new Set(['node_modules', '_harness'])

/** The `perf-results/<os>/` folder name of a Node platform. */
export function osName(platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return platform
}

/** Every perf case under `<root>/perf/`, as sorted repository-relative posix paths. */
function discoverCases(root) {
  const cases = []
  const walk = (relativeDir) => {
    const absolute = path.join(root, relativeDir)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(relative)
      } else if (entry.isFile() && CASE_FILE.test(entry.name)) {
        cases.push(relative)
      }
    }
  }
  walk('perf')
  return cases.sort()
}

/** Runs one case module and returns its samples. */
async function runCase(root, relative) {
  const module = await import(pathToFileURL(path.join(root, relative)).href)
  if (typeof module.default !== 'function') {
    throw new Error(`perf case ${relative} must default-export a function returning its samples`)
  }
  const samples = await module.default()
  if (!Array.isArray(samples)) {
    throw new Error(`perf case ${relative} must return an array of samples`)
  }
  return samples
}

/** Appends `records` to the JSON array in `file`, creating it (and its folder) when absent. */
function appendRecords(file, records) {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  if (!Array.isArray(existing)) throw new Error(`perf results file is not a JSON array: ${file}`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify([...existing, ...records], null, 2)}\n`)
}

/**
 * Runs every perf case under `root` (or only the case `only` names) and appends their records to
 * `<root>/perf-results/<os>/<date>.json`. Returns `{ ok, file, records }`; `file` is `null` when
 * there is no case yet.
 */
export async function runPerf({ root, os, date, commit, only }) {
  let cases = discoverCases(root)
  if (only !== undefined) {
    if (!cases.includes(only)) throw new Error(`no perf case ${only} under perf/`)
    cases = [only]
  }
  const records = []
  const failures = []
  for (const relative of cases) {
    try {
      records.push({ os, date, commit, case: relative, samples: await runCase(root, relative) })
    } catch (error) {
      if (!Array.isArray(error?.samples)) throw error
      records.push({
        os,
        date,
        commit,
        case: relative,
        samples: error.samples,
        failure: error.message
      })
      failures.push(`perf case ${relative} failed: ${error.message}`)
    }
  }
  if (records.length === 0) return { ok: true, file: null, records }
  const file = path.join(root, 'perf-results', os, `${date}.json`)
  appendRecords(file, records)
  if (failures.length > 0) {
    throw new Error(`${failures.join('; ')} (records appended to ${path.relative(root, file)})`)
  }
  return { ok: true, file, records }
}

/** A relative specifier whose last segment has no extension (`./b`, `../kernel/domain/processIdentity`). */
const EXTENSIONLESS_RELATIVE = /^\.{1,2}\/(?:.*\/)?[^/.]+$/

/**
 * Lets Node resolve `./name` to `./name.ts` when `./name` itself is not found, as Playwright's loader does for the
 * E2E harness a case imports. Every other resolution is Node's own.
 */
function resolveExtensionlessTypeScript(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !EXTENSIONLESS_RELATIVE.test(specifier))
      throw error
    return nextResolve(`${specifier}.ts`, context)
  }
}

/** The commit a CI run or a local checkout measures. */
function currentCommit(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

/** Runs the perf lane as the command line does; returns the exit code. */
export async function runPerfCli(argv, io) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const rootFlag = argv.indexOf('--root')
  const root = path.resolve(rootFlag === -1 ? path.join(here, '..', '..') : argv[rootFlag + 1])
  const caseFlag = argv.indexOf('--case')
  const only = caseFlag === -1 ? undefined : argv[caseFlag + 1]?.replaceAll('\\', '/')
  try {
    const { file, records } = await runPerf({
      root,
      os: osName(process.platform),
      date: new Date().toISOString().slice(0, 10),
      commit: currentCommit(root),
      only
    })
    if (file === null) {
      io.out('perf: no perf/**/*.perf.ts case yet; nothing recorded (17 §1.11)')
      return 0
    }
    for (const record of records) io.out(`perf: ${record.case}: ${record.samples.length} sample(s)`)
    io.out(`perf: ${records.length} record(s) appended to ${path.relative(root, file)}`)
    return 0
  } catch (error) {
    io.err(`perf: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerHooks({ resolve: resolveExtensionlessTypeScript })
  process.exitCode = await runPerfCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
