#!/usr/bin/env node
/**
 * The perf lane's release-check reader (ISSUE-297; testing strategy `17` §1.11; ADR-034 item 4; ADR-025
 * Verification "Perf: Veta idle CPU recorded per OS as release evidence"; NFR-PERF-04, NFR-OBS-03).
 *
 * It reads the records the perf runner (`runPerf.mjs`) appended on each OS, `perf-results/<os>/<date>.json` (one
 * record `{ os, date, commit, case, samples }` per case), and turns every sample that names its `scene` and `process`
 * into one evidence row per OS, scene and process: `{ os, date, commit, case, scene, process, samples, mean, max,
 * requirements }`, the CPU being Electron's `percentCPUUsage` (a percentage of one core).
 *
 * - The release evidence of the Veta epic needs both Veta idle scenes (no sessions; every dwarf asleep), each for the
 *   Veta renderer and the whole app, on Windows, macOS and Linux (ADR-034 item 4). A missing row fails the check and
 *   is named; every other scene (the ISSUE-283 idle Panel) is listed beside them.
 * - No CPU threshold is read or applied: `17` §1.11 records each OS without a gate until the lead records its baseline
 *   and margin there. A high sample is evidence, never a failure.
 * - It reads only; it is never a pull-request check (`17` §1.11, HO-38).
 *
 * Usage: node perf/_harness/releaseEvidence.mjs [--from <folder>] [--commit <sha>]
 * `--from` is the folder holding the results files, searched at any depth (default `perf-results/` of the repository,
 * or the folder the three OS artifacts were downloaded to); `--commit` keeps only the records of the released commit.
 * Exit code 0 when every required row is there, 1 with what is missing on stderr otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the Veta epic's release evidence needs: both idle scenes, the Veta renderer and the app, on each OS. */
export const VETA_IDLE_EVIDENCE = {
  oses: ['windows', 'macos', 'linux'],
  scenes: ['veta-no-sessions', 'veta-all-asleep'],
  processes: ['renderer', 'app']
}

/** The requirement ids a scene's rows are evidence for. */
function requirementsOf(scene) {
  return VETA_IDLE_EVIDENCE.scenes.includes(scene)
    ? ['NFR-PERF-04', 'NFR-OBS-03', 'NFR-PLAT']
    : ['NFR-PERF-04', 'NFR-OBS-03']
}

/** Every record of every `*.json` results file under `folder`, at any depth; a file that is not an array is skipped. */
export function readPerfResults(folder) {
  const records = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const parsed = JSON.parse(readFileSync(absolute, 'utf8'))
        if (Array.isArray(parsed)) records.push(...parsed)
      }
    }
  }
  walk(folder)
  return records
}

/** A sample that names its scene, its process and a numeric CPU. */
const isSceneSample = (sample) =>
  sample !== null &&
  typeof sample === 'object' &&
  typeof sample.scene === 'string' &&
  typeof sample.process === 'string' &&
  typeof sample.cpu === 'number'

/**
 * The evidence of `records`: one row per record, scene and process, and the required Veta idle rows missing.
 * `options.commit` keeps only the records of that commit.
 */
export function releaseEvidence(records, options = {}) {
  const groups = new Map()
  for (const record of records) {
    if (options.commit !== undefined && record.commit !== options.commit) continue
    if (!Array.isArray(record.samples)) continue
    for (const sample of record.samples.filter(isSceneSample)) {
      const key = [
        record.os,
        record.date,
        record.commit,
        record.case,
        sample.scene,
        sample.process
      ].join('\n')
      if (!groups.has(key))
        groups.set(key, { record, scene: sample.scene, process: sample.process, cpu: [] })
      groups.get(key).cpu.push(sample.cpu)
    }
  }
  const rows = [...groups.values()].map(({ record, scene, process, cpu }) => ({
    os: record.os,
    date: record.date,
    commit: record.commit,
    case: record.case,
    scene,
    process,
    samples: cpu.length,
    mean: cpu.reduce((sum, value) => sum + value, 0) / cpu.length,
    max: Math.max(...cpu),
    requirements: requirementsOf(scene)
  }))
  const missing = []
  for (const os of VETA_IDLE_EVIDENCE.oses) {
    for (const scene of VETA_IDLE_EVIDENCE.scenes) {
      for (const process of VETA_IDLE_EVIDENCE.processes) {
        const found = rows.some(
          (row) => row.os === os && row.scene === scene && row.process === process
        )
        if (!found) missing.push({ os, scene, process })
      }
    }
  }
  return { ok: missing.length === 0, rows, missing }
}

/** The CPU as the table shows it: two decimals, a percentage of one core. */
const percent = (value) => `${value.toFixed(2)} %`

/** Runs the reader as the command line does; returns the exit code. */
export function releaseEvidenceCli(argv, io) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const flag = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  const from = path.resolve(flag('--from') ?? path.join(here, '..', '..', 'perf-results'))
  const commit = flag('--commit')
  try {
    const { ok, rows, missing } = releaseEvidence(readPerfResults(from), { commit })
    io.out('| OS | Scene | Process | Samples | Mean CPU | Max CPU | Date | Commit | Evidence for |')
    io.out('| -- | ----- | ------- | ------- | -------- | ------- | ---- | ------ | ------------ |')
    for (const row of rows) {
      io.out(
        `| ${row.os} | ${row.scene} | ${row.process} | ${row.samples} | ${percent(row.mean)} | ${percent(row.max)} | ` +
          `${row.date} | ${String(row.commit).slice(0, 12)} | ${row.requirements.join(', ')} |`
      )
    }
    io.out(
      'No threshold applied: each OS is recorded without a gate until its baseline is in 17 §1.11.'
    )
    if (!ok) {
      io.err('perf evidence: the Veta idle release evidence is missing (ADR-034 item 4):')
      for (const gap of missing) io.err(`  ${gap.os}: ${gap.scene} ${gap.process}`)
      return 1
    }
    return 0
  } catch (error) {
    io.err(`perf evidence: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = releaseEvidenceCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
