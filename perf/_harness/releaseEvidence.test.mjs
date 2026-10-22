// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readPerfResults,
  releaseEvidence,
  releaseEvidenceCli,
  VETA_IDLE_EVIDENCE
} from './releaseEvidence.mjs'

/**
 * L7 check of the perf lane's release-check reader (ISSUE-297; testing strategy `17` §1.11; ADR-034 item 4;
 * ADR-025 Verification "Perf: Veta idle CPU recorded per OS as release evidence").
 *
 * The reader takes the records the perf runner appended on each OS (`perf-results/<os>/<date>.json`, one record
 * `{ os, date, commit, case, samples }` per case, each sample `{ scene, process, api, cpu }`), turns them into one
 * evidence row per OS, scene and process, and fails only when a required row is missing on one of the three OSes.
 * No CPU threshold is read or applied: `17` §1.11 records each OS without a gate until the lead records its baseline.
 */

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

const COMMIT = 'f6d0bf4161ea5e754a89b99f2a7881788e829ff3'

/** One Veta idle record of `os`: both scenes, the Veta renderer and the app's total, `cpu` for every sample. */
function vetaRecord(os, cpu = 0.5, commit = COMMIT) {
  const samples = []
  for (const scene of ['veta-no-sessions', 'veta-all-asleep']) {
    for (const process of ['renderer', 'app']) {
      samples.push({ scene, process, api: 'app.getAppMetrics().cpu.percentCPUUsage', cpu })
      samples.push({ scene, process, api: 'app.getAppMetrics().cpu.percentCPUUsage', cpu: cpu * 3 })
    }
  }
  return { os, date: '2026-10-21', commit, case: 'perf/vetaIdle.perf.ts', samples }
}

/** The ISSUE-283 idle-scene record of `os`. */
function panelRecord(os) {
  return {
    os,
    date: '2026-10-21',
    commit: COMMIT,
    case: 'perf/idleScene.perf.ts',
    samples: [
      {
        scene: 'panel-idle',
        process: 'renderer',
        api: 'app.getAppMetrics().cpu.percentCPUUsage',
        cpu: 1
      },
      {
        scene: 'panel-idle',
        process: 'renderer',
        api: 'app.getAppMetrics().cpu.percentCPUUsage',
        cpu: 2
      }
    ]
  }
}

describe('perf release evidence (17 §1.11, ADR-034 item 4)', () => {
  it('[NFR-PERF-04, NFR-OBS-03, ADR-034] the Veta idle records of the three OSes become one evidence row per OS, scene and process', () => {
    const records = ['windows', 'macos', 'linux'].map((os) => vetaRecord(os))

    const evidence = releaseEvidence(records)

    expect(evidence.ok).toBe(true)
    expect(evidence.missing).toEqual([])
    expect(evidence.rows).toHaveLength(12)
    expect(evidence.rows).toContainEqual({
      os: 'macos',
      date: '2026-10-21',
      commit: COMMIT,
      case: 'perf/vetaIdle.perf.ts',
      scene: 'veta-all-asleep',
      process: 'app',
      samples: 2,
      mean: 1,
      max: 1.5,
      requirements: ['NFR-PERF-04', 'NFR-OBS-03', 'NFR-PLAT']
    })
  })

  it('[ADR-034, ADR-025] a Veta idle row missing on one OS fails the release evidence and names what is missing', () => {
    const records = [vetaRecord('windows'), vetaRecord('linux'), panelRecord('macos')]

    const evidence = releaseEvidence(records)

    expect(evidence.ok).toBe(false)
    expect(evidence.missing).toEqual([
      { os: 'macos', scene: 'veta-no-sessions', process: 'renderer' },
      { os: 'macos', scene: 'veta-no-sessions', process: 'app' },
      { os: 'macos', scene: 'veta-all-asleep', process: 'renderer' },
      { os: 'macos', scene: 'veta-all-asleep', process: 'app' }
    ])
  })

  it('[NFR-OBS-03, ADR-025] no CPU threshold is applied: a very high Veta idle CPU is still recorded evidence, not a failure', () => {
    const records = ['windows', 'macos', 'linux'].map((os) => vetaRecord(os, 400))

    const evidence = releaseEvidence(records)

    expect(evidence.ok).toBe(true)
    expect(evidence.rows.every((row) => row.max === 1200)).toBe(true)
  })

  it('[NFR-OBS-03] the other perf scenes are listed beside the Veta rows, and only the release commit counts when one is named', () => {
    const records = [
      ...['windows', 'macos', 'linux'].map((os) => vetaRecord(os)),
      panelRecord('windows'),
      vetaRecord('linux', 9, 'a'.repeat(40))
    ]

    const all = releaseEvidence(records)
    const tagged = releaseEvidence(records, { commit: COMMIT })

    expect(all.rows.filter((row) => row.scene === 'panel-idle')).toEqual([
      expect.objectContaining({ os: 'windows', process: 'renderer', samples: 2, mean: 1.5, max: 2 })
    ])
    expect(all.rows.some((row) => row.commit === 'a'.repeat(40))).toBe(true)
    expect(tagged.rows.some((row) => row.commit === 'a'.repeat(40))).toBe(false)
    expect(tagged.ok).toBe(true)
  })

  it('[NFR-OBS-03] the required Veta evidence is the two idle scenes, each for the Veta renderer and the whole app, on the three OSes', () => {
    expect(VETA_IDLE_EVIDENCE).toEqual({
      oses: ['windows', 'macos', 'linux'],
      scenes: ['veta-no-sessions', 'veta-all-asleep'],
      processes: ['renderer', 'app']
    })
  })

  it('[NFR-OBS-03, ADR-034] the reader collects every results file under a folder, as the three OS artifacts land', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perf-evidence-'))
    tempRoots.push(root)
    for (const os of ['windows', 'macos', 'linux']) {
      const dir = path.join(root, `perf-results-${os}`, os)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, '2026-10-21.json'), JSON.stringify([vetaRecord(os)]))
    }
    writeFileSync(path.join(root, 'notes.txt'), 'not a results file')

    const records = readPerfResults(root)
    const out = []
    const err = []
    const code = releaseEvidenceCli(['--from', root, '--commit', COMMIT], {
      out: (line) => out.push(line),
      err: (line) => err.push(line)
    })

    expect(records.map((record) => record.os).sort()).toEqual(['linux', 'macos', 'windows'])
    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('| windows | veta-no-sessions | renderer |')
  })

  it('[ADR-034] the reader exits 1 and names the OS when a Veta idle record is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perf-evidence-'))
    tempRoots.push(root)
    mkdirSync(path.join(root, 'windows'), { recursive: true })
    writeFileSync(
      path.join(root, 'windows', '2026-10-21.json'),
      JSON.stringify([vetaRecord('windows')])
    )

    const err = []
    const code = releaseEvidenceCli(['--from', root], {
      out: () => {},
      err: (line) => err.push(line)
    })

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('macos: veta-no-sessions renderer')
    expect(err.join('\n')).toContain('linux: veta-all-asleep app')
  })

  it('[S-034-1, NFR-PERF-10] a Control-room scaling row is evidence for NFR-PERF-10, its frame-time summary no CPU row', () => {
    const scene = 'control-room-16-degradation-on-sustained-scroll'
    const record = {
      os: 'windows',
      date: '2026-10-22',
      commit: COMMIT,
      case: 'perf/valleScaling.perf.ts',
      samples: [
        { scene, process: 'renderer', api: 'app.getAppMetrics().cpu.percentCPUUsage', cpu: 0.8 },
        { scene, process: 'renderer', metric: 'frame-time', frameMs: { p50: 16.7 } }
      ]
    }

    const { rows } = releaseEvidence([record])

    expect(rows).toEqual([
      expect.objectContaining({
        scene,
        process: 'renderer',
        samples: 1,
        requirements: ['NFR-PERF-10']
      })
    ])
  })
})
