// layer: L7
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { environmentRecord, packagedLayout, planSpikes, SPIKE_IDS } from './spike-lane.mjs'

// The helpers of the manually dispatched spike lane (.github/workflows/spikes.yml, docs/spikes-lane.md): which spikes
// a dispatch runs, where the packaged app of the runner's OS is, and the environment line each evidence folder
// carries for its spike-results record (17 §4: tool versions, OS and date).

describe('spike lane plan', () => {
  it('[SP-16, SP-04, SP-03, SP-05, S-019-1, S-030-1, S-027-4] "all" selects every spike the lane runs', () => {
    const plan = planSpikes('all')
    expect(Object.keys(plan).sort()).toEqual([...SPIKE_IDS].sort())
    expect(Object.values(plan).every((selected) => selected === true)).toBe(true)
  })

  it('[SP-16, SP-04] a comma or space separated list selects exactly those spikes', () => {
    const plan = planSpikes(' SP-16, SP-04  S-019-1 ')
    expect(
      Object.entries(plan)
        .filter(([, selected]) => selected)
        .map(([id]) => id)
    ).toEqual(['SP-16', 'SP-04', 'S-019-1'])
  })

  it('[SP-16] an unknown id or an empty selection is refused with the known ids', () => {
    expect(() => planSpikes('SP-16,SP-99')).toThrow(/unknown spike id SP-99.*SP-16/)
    expect(() => planSpikes('  ')).toThrow(/no spike selected/)
  })
})

describe('packaged layout of the runner OS', () => {
  const app = { productName: 'DwarfAI-Miners', executableName: 'dwarfai-miners' }

  it('[SP-04, SP-03] Windows: the win-unpacked folder and its product executable', () => {
    const layout = packagedLayout({
      ...app,
      platform: 'win32',
      arch: 'x64',
      releaseDir: 'release',
      files: []
    })
    expect(layout).toEqual({
      dir: path.join('release', 'win-unpacked'),
      exe: path.join('release', 'win-unpacked', 'DwarfAI-Miners.exe'),
      appImage: null
    })
  })

  it('[SP-04, SP-03] macOS: the .app bundle of the runner arch and its Contents/MacOS executable', () => {
    const arm = packagedLayout({
      ...app,
      platform: 'darwin',
      arch: 'arm64',
      releaseDir: 'release',
      files: []
    })
    expect(arm.dir).toBe(path.join('release', 'mac-arm64', 'DwarfAI-Miners.app'))
    expect(arm.exe).toBe(path.join(arm.dir, 'Contents', 'MacOS', 'DwarfAI-Miners'))
    const intel = packagedLayout({
      ...app,
      platform: 'darwin',
      arch: 'x64',
      releaseDir: 'release',
      files: []
    })
    expect(intel.dir).toBe(path.join('release', 'mac', 'DwarfAI-Miners.app'))
  })

  it('[SP-04, SP-03] Linux: linux-unpacked, its executable name and the AppImage beside it', () => {
    const layout = packagedLayout({
      ...app,
      platform: 'linux',
      arch: 'x64',
      releaseDir: 'release',
      files: [
        'DwarfAI-Miners-1.0.0-amd64.deb',
        'DwarfAI-Miners-1.0.0-x86_64.AppImage',
        'linux-unpacked'
      ]
    })
    expect(layout).toEqual({
      dir: path.join('release', 'linux-unpacked'),
      exe: path.join('release', 'linux-unpacked', 'dwarfai-miners'),
      appImage: path.join('release', 'DwarfAI-Miners-1.0.0-x86_64.AppImage')
    })
  })
})

describe('environment line of an evidence folder', () => {
  it('[SP-16] names the runner image, OS release, tool versions, commit and date, and nothing personal', () => {
    const record = environmentRecord({
      label: 'keyring-ubuntu-latest-secret-service',
      spikes: ['SP-16'],
      env: {
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        ImageOS: 'ubuntu24',
        ImageVersion: '20261012.1.0',
        GITHUB_SHA: 'abc123',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        RUNNER_NAME: 'GitHub Actions 7',
        HOME: '/home/runner'
      },
      osRelease: '6.17.0-1022-azure',
      node: 'v24.21.0',
      pkg: {
        dependencies: { '@napi-rs/keyring': '2.1.0' },
        devDependencies: { electron: '44.0.0', 'electron-builder': '26.15.3' }
      },
      now: new Date('2026-10-18T10:00:00Z')
    })
    expect(record).toEqual({
      label: 'keyring-ubuntu-latest-secret-service',
      date: '2026-10-18',
      spikes: ['SP-16'],
      runner: { os: 'Linux', arch: 'X64', image: 'ubuntu24', imageVersion: '20261012.1.0' },
      osRelease: '6.17.0-1022-azure',
      versions: {
        node: 'v24.21.0',
        electron: '44.0.0',
        electronBuilder: '26.15.3',
        napiRsKeyring: '2.1.0'
      },
      commit: 'abc123',
      run: { id: '42', attempt: '1' }
    })
    expect(JSON.stringify(record)).not.toMatch(/GitHub Actions 7|\/home\/runner/)
  })
})
