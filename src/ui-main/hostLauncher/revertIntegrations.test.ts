// layer: L2
import { describe, expect, it } from 'vitest'
import { FakeCopyPreparer } from './fakes/FakeCopyPreparer'
import { FakeLauncherClock } from './fakes/FakeLauncherClock'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import type { HostSpawnRequest } from './ports'
import {
  REVERT_GATE_BOUND_MS,
  REVERT_INTEGRATIONS_FLAG,
  runHostRevertIntegrations,
  wantsRevertIntegrations
} from './revertIntegrations'

// L2 (17 §1.2): UI main's half of `--revert-integrations` (ADR-016 item 7; ISSUE-225 lead decision):
// it runs this build's versioned Host copy (ADR-002 D5) in the revert mode, as the launcher builds a
// Host start (ELECTRON_RUN_AS_NODE, DWARFAI_HOST_DATA_DIR; spawnHost.ts), waits for it and answers
// its exit code. No real process, file or timer.

const APP_DIR = 'C:\\Program Files\\DwarfAI-Miners'
const COPY_DIR = 'C:\\Users\\p\\AppData\\Local\\DwarfAI-Miners\\host\\0.20.0'
const HOST = {
  execPath: `${APP_DIR}\\DwarfAI-Miners.exe`,
  hostEntry: `${APP_DIR}\\resources\\app.asar\\out\\host\\main.js`,
  hostDataDir: 'C:\\Users\\p\\AppData\\Roaming\\DwarfAI-Miners\\host',
  uiEnv: { PATH: 'C:\\Windows', DWARFAI_LEGACY_TOKEN: 'never-passed' }
}

function world(options: { exit?: number | null; gateHeldFor?: number } = {}) {
  const calls: string[] = []
  const requests: HostSpawnRequest[] = []
  const clock = new FakeLauncherClock(1_000)
  const copies = new FakeCopyPreparer(APP_DIR, COPY_DIR)
  const log = new RecordingUiLog()
  const heldUntil = clock.now() + (options.gateHeldFor ?? 0)
  return {
    calls,
    requests,
    clock,
    copies,
    log,
    run: () =>
      runHostRevertIntegrations({
        gate: {
          take: async () => {
            calls.push('take-gate')
            return clock.now() < heldUntil ? 'held' : 'taken'
          },
          release: async () => void calls.push('release-gate')
        },
        prepareCopy: async () => {
          calls.push('prepare-copy')
          return copies.prepare()
        },
        host: HOST,
        run: async (request) => {
          calls.push('run')
          requests.push(request)
          return options.exit === undefined ? 0 : options.exit
        },
        clock,
        sleep: clock.sleep,
        log
      })
  }
}

describe('UI main runs the Host copy in the revert mode (ADR-016 item 7; ISSUE-225)', () => {
  it('[ADR-016] the command runs the versioned Host copy with --revert-integrations and exits with its code', async () => {
    const w = world({ exit: 0 })

    expect(await w.run()).toBe(0)

    expect(w.calls).toEqual(['take-gate', 'prepare-copy', 'run', 'release-gate'])
    expect(w.requests).toHaveLength(1)
    const request = w.requests[0] as HostSpawnRequest
    // ADR-002 D5: the copy's executable and entry, never the install folder's.
    expect(request.file).toBe(`${COPY_DIR}\\DwarfAI-Miners.exe`)
    expect(request.args).toEqual([
      `${COPY_DIR}\\resources\\app.asar\\out\\host\\main.js`,
      REVERT_INTEGRATIONS_FLAG
    ])
    expect(request.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      DWARFAI_HOST_DATA_DIR: HOST.hostDataDir
    })
    expect(request.env).not.toHaveProperty('DWARFAI_LEGACY_TOKEN')
    expect(await world({ exit: 3 }).run()).toBe(3)
  })

  it('[ADR-016] a Host copy that cannot be made fails the command non-zero and starts nothing', async () => {
    const w = world()
    w.copies.outcome = { ok: false, errCode: 'COPY_FAILED' }

    expect(await w.run()).not.toBe(0)
    expect(w.calls).toEqual(['take-gate', 'prepare-copy', 'release-gate'])
  })

  it('[ADR-016] a Host that ends without an exit code fails the command non-zero', async () => {
    expect(await world({ exit: null }).run()).not.toBe(0)
  })

  it('[ADR-016] a spawn gate another launcher holds is waited for within the 30 s bound', async () => {
    const waited = world({ gateHeldFor: 1_000 })
    expect(await waited.run()).toBe(0)
    expect(waited.calls.filter((call) => call === 'run')).toHaveLength(1)

    const stuck = world({ gateHeldFor: REVERT_GATE_BOUND_MS + 1_000 })
    expect(await stuck.run()).not.toBe(0)
    expect(stuck.calls).not.toContain('run')
    expect(stuck.calls).not.toContain('release-gate')
  })

  it('[ADR-016] only --revert-integrations selects the revert mode', () => {
    expect(wantsRevertIntegrations(['DwarfAI-Miners.exe', REVERT_INTEGRATIONS_FLAG])).toBe(true)
    expect(wantsRevertIntegrations(['electron', '.', REVERT_INTEGRATIONS_FLAG])).toBe(true)
    expect(wantsRevertIntegrations(['DwarfAI-Miners.exe', '--background'])).toBe(false)
    expect(wantsRevertIntegrations(['DwarfAI-Miners.exe', '--revert-integrations=1'])).toBe(false)
  })
})
