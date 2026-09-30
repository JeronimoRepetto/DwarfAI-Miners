// L8 OS lane (17 §1.8): the real probe against a real stub process, one describe per OS. Runs only
// in `pnpm test:os`. The spawned process is the sleeper stub, never a provider CLI.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { NodeProcessControl } from './NodeProcessControl'

const SLEEPER = fileURLToPath(
  new URL('../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)

/** This boot's id read straight from the OS source of ADR-015 item 4, independent of the adapter. */
function thisBootId(): string {
  if (process.platform === 'linux') {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  }
  if (process.platform === 'darwin') {
    return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim()
  }
  const filetime = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTime()'
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  const bootMs = Number((BigInt(filetime) - 116_444_736_000_000_000n) / 10_000n)
  return String(Math.round(bootMs / 1_000) * 1_000)
}

function probeCases(): void {
  let running: { child: SpawnedProcess; pid: number | null } | null = null

  afterEach(async () => {
    // Leave nothing running: close the stub's stdin (it exits), and kill it if it has not.
    if (running === null) return
    const { child, pid } = running
    running = null
    child.stdin?.end()
    const settled = await Promise.race([
      child.exited.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
    ])
    if (!settled && pid !== null) process.kill(pid)
  })

  const startSleeper = (control: NodeProcessControl): SpawnedProcess => {
    const child = control.spawn({
      executable: process.execPath,
      args: [SLEEPER, 'sleep', '20000'],
      env: {},
      cwd: dirname(SLEEPER),
      processGroup: 'inherit',
      stdio: 'pipe'
    })
    running = { child, pid: null }
    return child
  }

  it("[ADR-014] probe of a spawned stub returns its pid, a start time within tolerance of the spawn and this boot's bootId", async () => {
    const control = new NodeProcessControl()
    const spawnedAt = Date.now()
    const child = startSleeper(control)
    const identity = await child.identity
    if (running !== null) running.pid = identity.pid

    const probed = await control.probe(identity.pid)

    expect(probed).not.toBe('absent')
    expect(probed).not.toBe('unknown')
    const found = probed as ProcessIdentity
    expect(found.pid).toBe(identity.pid)
    expect(Math.abs(found.processStartTimeMs - spawnedAt)).toBeLessThanOrEqual(
      PROCESS_START_TOLERANCE_MS
    )
    expect(found.bootId).toBe(thisBootId())
    expect(control.sameProcess(found, identity)).toBe(true)
  }, 20_000)

  it('[ADR-014] probe of the stub after it exited returns absent', async () => {
    const control = new NodeProcessControl()
    const child = startSleeper(control)
    const identity = await child.identity
    if (running !== null) running.pid = identity.pid

    child.stdin?.end()
    expect(await child.exited).toEqual({ code: 0, signal: null })

    expect(await control.probe(identity.pid)).toBe('absent')
  }, 20_000)
}

describe.runIf(process.platform === 'win32')('NodeProcessControl on Windows', probeCases)
describe.runIf(process.platform === 'darwin')('NodeProcessControl on macOS', probeCases)
describe.runIf(process.platform === 'linux')('NodeProcessControl on Linux', probeCases)
