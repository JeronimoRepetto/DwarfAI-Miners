// layer: L7
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { osName, runPerf } from './runPerf.mjs'

const RUNNER = fileURLToPath(new URL('./runPerf.mjs', import.meta.url))

/**
 * L7 check of the perf runner (testing strategy `17` §1.11).
 *
 * `pnpm test:perf` discovers `perf/**\/*.perf.ts`, runs each case and appends one record
 * `{ os, date, commit, case, samples }` per case to `perf-results/<os>/<date>.json`. No threshold
 * exists yet: a measured budget without a number is recorded without a gate until its baseline is
 * recorded in `17` §1.11, so a slow sample never fails the run.
 */

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** A temporary repository root holding the given perf cases, `{ '<relative path>': source }`. */
function repoWithCases(cases) {
  const root = mkdtempSync(path.join(tmpdir(), 'perf-runner-'))
  tempRoots.push(root)
  for (const [relative, source] of Object.entries(cases)) {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return root
}

const RUN = { os: 'linux', date: '2026-09-30', commit: 'f6d0bf4161ea5e754a89b99f2a7881788e829ff3' }

/** The records of one results file, or none when the runner wrote no file. */
function readResults(root, run = RUN) {
  const file = path.join(root, 'perf-results', run.os, `${run.date}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

describe('perf runner (17 §1.11)', () => {
  it('[NFR-OBS-03] a perf case appends one record with os, date, commit and samples to perf-results/<os>/<date>.json', async () => {
    const root = repoWithCases({
      'perf/idle/scene.perf.ts':
        'export default async function run(): Promise<number[]> {\n  return [12.5, 13.25]\n}\n'
    })

    await runPerf({ root, ...RUN })

    expect(readResults(root)).toEqual([
      {
        os: 'linux',
        date: '2026-09-30',
        commit: RUN.commit,
        case: 'perf/idle/scene.perf.ts',
        samples: [12.5, 13.25]
      }
    ])
  })

  it('[NFR-OBS-03] two runs on the same day append, never overwrite', async () => {
    const root = repoWithCases({
      'perf/boot.perf.ts': 'export default function run(): number[] {\n  return [1]\n}\n'
    })

    await runPerf({ root, ...RUN })
    await runPerf({ root, ...RUN, commit: 'a'.repeat(40) })

    const records = readResults(root)
    expect(records.map((record) => record.commit)).toEqual([RUN.commit, 'a'.repeat(40)])
    expect(records.every((record) => record.case === 'perf/boot.perf.ts')).toBe(true)
  })

  it('[NFR-OBS-03] no threshold is applied and a slow sample does not fail the run', async () => {
    const root = repoWithCases({
      'perf/slow.perf.ts':
        'export default function run(): number[] {\n  return [Number.MAX_SAFE_INTEGER]\n}\n',
      // A thresholds file beside the cases is never read yet (17 §1.11: no baseline recorded).
      'perf/thresholds.json': JSON.stringify({ 'perf/slow.perf.ts': 1 })
    })

    const result = await runPerf({ root, ...RUN })

    expect(result.ok).toBe(true)
    expect(readResults(root)).toEqual([
      expect.objectContaining({ case: 'perf/slow.perf.ts', samples: [Number.MAX_SAFE_INTEGER] })
    ])
    expect(existsSync(path.join(root, 'perf-results', 'linux', '2026-09-30.json'))).toBe(true)
  })

  it('[NFR-OBS-03] a case named with --case runs alone and only its record is appended', async () => {
    const root = repoWithCases({
      'perf/a.perf.ts': 'export default function run(): number[] {\n  return [1]\n}\n',
      'perf/b.perf.ts': 'export default function run(): number[] {\n  return [2]\n}\n'
    })

    await runPerf({ root, ...RUN, only: 'perf/b.perf.ts' })

    expect(readResults(root)).toEqual([
      expect.objectContaining({ case: 'perf/b.perf.ts', samples: [2] })
    ])
  })

  it('[NFR-OBS-03] a case reaches TypeScript modules imported without their extension, as the E2E harness it uses does', async () => {
    const root = repoWithCases({
      'perf/scene.perf.ts':
        "import { seven } from './lib/a.ts'\nexport default function run(): number[] {\n  return [seven()]\n}\n",
      'perf/lib/a.ts': "import { six } from './b'\nexport const seven = (): number => six() + 1\n",
      'perf/lib/b.ts': 'export const six = (): number => 6\n'
    })

    const result = spawnSync(
      process.execPath,
      [RUNNER, '--root', root, '--case', 'perf/scene.perf.ts'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: RUN.commit } }
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const os = osName(process.platform)
    const [file] = readdirSync(path.join(root, 'perf-results', os))
    const records = JSON.parse(readFileSync(path.join(root, 'perf-results', os, file), 'utf8'))
    expect(records).toEqual([expect.objectContaining({ case: 'perf/scene.perf.ts', samples: [7] })])
  })

  it('[NFR-OBS-03] a case that fails a check after measuring keeps its samples in the record, names the failure and fails the run', async () => {
    const root = repoWithCases({
      'perf/checked.perf.ts': [
        'export default function run(): number[] {',
        "  const failure = new Error('[ADR-025] the hidden window requested a frame')",
        '  Object.assign(failure, { samples: [0.5, 0.75] })',
        '  throw failure',
        '}',
        ''
      ].join('\n'),
      'perf/fine.perf.ts': 'export default function run(): number[] {\n  return [1]\n}\n'
    })

    await expect(runPerf({ root, ...RUN })).rejects.toThrow(
      'perf case perf/checked.perf.ts failed: [ADR-025] the hidden window requested a frame'
    )

    expect(readResults(root)).toEqual([
      {
        os: 'linux',
        date: '2026-09-30',
        commit: RUN.commit,
        case: 'perf/checked.perf.ts',
        samples: [0.5, 0.75],
        failure: '[ADR-025] the hidden window requested a frame'
      },
      expect.objectContaining({ case: 'perf/fine.perf.ts', samples: [1] })
    ])
  })

  it('[NFR-OBS-03] a --case that names no perf case fails the run and records nothing', async () => {
    const root = repoWithCases({
      'perf/a.perf.ts': 'export default function run(): number[] {\n  return [1]\n}\n'
    })

    await expect(runPerf({ root, ...RUN, only: 'perf/missing.perf.ts' })).rejects.toThrow(
      'no perf case perf/missing.perf.ts'
    )
    expect(readResults(root)).toEqual([])
  })
})
