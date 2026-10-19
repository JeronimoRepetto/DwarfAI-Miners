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
 * - A results file is a JSON array; a second run on the same day appends to it, never overwrites.
 *
 * Usage: node perf/_harness/runPerf.mjs [--root <repository root>]
 * Exit code 0 when every case ran (or there is none yet), 1 with the reason on stderr otherwise.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Runs every perf case under `root` and appends their records to
 * `<root>/perf-results/<os>/<date>.json`. Returns `{ ok, file, records }`; `file` is `null` when
 * there is no case yet.
 */
export async function runPerf({ root, os, date, commit }) {
  const records = []
  for (const relative of discoverCases(root)) {
    records.push({ os, date, commit, case: relative, samples: await runCase(root, relative) })
  }
  if (records.length === 0) return { ok: true, file: null, records }
  const file = path.join(root, 'perf-results', os, `${date}.json`)
  appendRecords(file, records)
  return { ok: true, file, records }
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
  try {
    const { file, records } = await runPerf({
      root,
      os: osName(process.platform),
      date: new Date().toISOString().slice(0, 10),
      commit: currentCommit(root)
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
  process.exitCode = await runPerfCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
