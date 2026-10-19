#!/usr/bin/env node
/**
 * Test-loss census gate (testing strategy `17` §2.6, §5.2; `skills/test-safety`).
 *
 * Runs `node skills/test-safety/assets/test-census.mjs --base <merge-base>`. The census exits 1
 * when a test file lost test statements; the gate then passes only if the same change added a row
 * to `docs/test-removals.md` for each losing file. "Added by the same change" means a row present
 * in the working tree that the merge base did not have (counted per file, so an old entry never
 * justifies a new loss). The gate reads that file, never PR text, and a rising total never hides a
 * loss: the census compares file by file.
 *
 * Usage: node scripts/checks/census-gate.mjs --base <merge-base ref>
 * Exit code 0 when no file lost statements or every loss has its new entry, 1 otherwise (with the
 * census report and one line per unjustified file on stderr).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CENSUS = path.join(REPO_ROOT, 'skills', 'test-safety', 'assets', 'test-census.mjs')
const REMOVALS = 'docs/test-removals.md'

/** A census row: `<path>  <before>  <after>  <delta>[  DELETED|  (new file)]`. */
const CENSUS_ROW = /^(\S(?:.*\S)?)\s+(\d+)\s+(\d+)\s+[+-]?\d+(?:\s+(?:DELETED|\(new file\)))?$/
const SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+$/

class CensusGateError extends Error {}

/** The rows of a census report, as `{ path, before, after }`. */
export function parseCensusOutput(output) {
  const rows = []
  for (const line of output.split(/\r?\n/)) {
    const row = CENSUS_ROW.exec(line.trim())
    if (row) rows.push({ path: row[1], before: Number(row[2]), after: Number(row[3]) })
  }
  return rows
}

/** The File cell of every entry row of the table in `docs/test-removals.md`, without backticks. */
export function removalFiles(markdown) {
  const rows = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
  // The first pipe row is the header and the second its separator; the rest are entries.
  return rows
    .filter((line, index) => index > 1 && !SEPARATOR_ROW.test(line))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .split('|')[0]
        .trim()
        .replace(/^`(.*)`$/, '$1')
    )
    .filter((file) => file !== '')
}

/** How many entries each file has. */
function countByFile(files) {
  const counts = new Map()
  for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1)
  return counts
}

/**
 * The gate's verdict on one census run: `census` is `{ exitCode, output }`, the two removals
 * texts are `docs/test-removals.md` in the working tree and at the merge base.
 */
export function evaluateCensusGate({ census, removalsNow, removalsAtBase }) {
  if (census.exitCode === 0) return { ok: true, losing: [], unjustified: [] }
  if (census.exitCode !== 1) {
    return { ok: false, losing: [], unjustified: [], error: `the census exited ${census.exitCode}` }
  }
  const losing = parseCensusOutput(census.output)
    .filter((row) => row.after < row.before)
    .map((row) => row.path)
  if (losing.length === 0) {
    return {
      ok: false,
      losing,
      unjustified: [],
      error: 'the census exited 1 but its report names no losing file'
    }
  }
  const now = countByFile(removalFiles(removalsNow))
  const atBase = countByFile(removalFiles(removalsAtBase))
  const added = (file) => (now.get(file) ?? 0) - (atBase.get(file) ?? 0)
  const unjustified = losing.filter((file) => added(file) < 1)
  return { ok: unjustified.length === 0, losing, unjustified }
}

/** The real side effects: the census run and the two readings of `docs/test-removals.md`. */
const REAL_DEPS = {
  runCensus(base) {
    const result = spawnSync(process.execPath, [CENSUS, '--base', base], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    if (result.error) throw result.error
    return { exitCode: result.status, output: `${result.stdout}${result.stderr}` }
  },
  readRemovalsNow() {
    return readFileSync(path.join(REPO_ROOT, REMOVALS), 'utf8')
  },
  readRemovalsAtBase(base) {
    try {
      return execFileSync('git', ['show', `${base}:${REMOVALS}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return '' // the file did not exist at the merge base: every row is new
    }
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new CensusGateError(`${name} <merge-base ref> is required`)
  }
  return value
}

/** Runs the gate as the command line does; returns the exit code. */
export function runCensusGate(argv, io, deps = REAL_DEPS) {
  try {
    const base = optionValue(argv, '--base')
    const census = deps.runCensus(base)
    const verdict = evaluateCensusGate({
      census,
      removalsNow: deps.readRemovalsNow(),
      removalsAtBase: deps.readRemovalsAtBase(base)
    })
    const report = census.output.trimEnd()
    if (verdict.ok) {
      if (report) io.out(report)
      io.out(
        verdict.losing.length === 0
          ? 'census gate: no test file lost statements'
          : `census gate: ${verdict.losing.length} loss(es), each with its new ${REMOVALS} entry`
      )
      return 0
    }
    if (report) io.err(report)
    if (verdict.error) io.err(`census gate: ${verdict.error}`)
    for (const file of verdict.unjustified) {
      io.err(
        `census gate: ${file} lost test statements and ${REMOVALS} gained no entry for it (17 §2.6)`
      )
    }
    return 1
  } catch (error) {
    if (!(error instanceof CensusGateError)) throw error
    io.err(`census gate: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCensusGate(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
