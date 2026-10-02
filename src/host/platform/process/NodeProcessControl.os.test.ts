// L8 OS lane (17 §1.8): the real probe against a real stub process, one describe per OS. Runs only
// in `pnpm test:os`. The spawned process is the sleeper stub, never a provider CLI.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { NodeProcessControl, createQueryRunner } from './NodeProcessControl'

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
  // ISSUE-019: the Windows boot id is the registry BootId counter (was CIM LastBootUpTime, too
  // slow for the 2 000 ms bound on a cold runner), read here through PowerShell's registry
  // provider rather than the adapter's reg.exe.
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters').BootId"
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
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

  // The Host's PATH is the person's environment. Its own identity (run/host.identity, ADR-002 D3) must not depend on
  // it: on macOS a PATH without /usr/sbin once left `sysctl` unfound, the identity unreadable and no identity file
  // written (CI run 36940954328). Every OS tool the probe runs is named by path, so a PATH of one empty folder reads
  // the same identity.
  it('[ADR-014] probe reads the same identity when PATH names only an empty folder', async () => {
    const control = new NodeProcessControl()
    const child = startSleeper(control)
    const identity = await child.identity
    if (running !== null) running.pid = identity.pid
    const empty = mkdtempSync(join(tmpdir(), 'dwarfai-empty-path-'))
    const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH')
    const saved = keys.map((key) => [key, process.env[key]] as const)
    let probed: Awaited<ReturnType<NodeProcessControl['probe']>>
    try {
      for (const key of keys) process.env[key] = empty
      probed = await new NodeProcessControl().probe(identity.pid)
    } finally {
      for (const [key, value] of saved) process.env[key] = value
      rmSync(empty, { recursive: true, force: true })
    }

    expect(probed).not.toBe('unknown')
    expect(probed).not.toBe('absent')
    expect((probed as ProcessIdentity).bootId).toBe(thisBootId())
    expect(control.sameProcess(probed as ProcessIdentity, identity)).toBe(true)
  }, 20_000)

  it('[INV-51] the default query runner ends a query that outlives its bound on real Node timers', async () => {
    // The L3 tests drive the bound on a FakeScheduler; this one proves the default wiring. The
    // child would answer after 10 s, so only a bound that really fires at 300 ms can end it first:
    // load can delay the child, never make it answer sooner.
    const out = await createQueryRunner()(
      process.execPath,
      ['-e', 'setTimeout(() => process.stdout.write("unbounded"), 10_000)'],
      { timeoutMs: 300 }
    )

    expect(out).toEqual({ ok: false, cause: 'timed out after 300 ms' })
  }, 20_000)
}

describe.runIf(process.platform === 'win32')('NodeProcessControl on Windows', probeCases)
describe.runIf(process.platform === 'darwin')('NodeProcessControl on macOS', probeCases)
describe.runIf(process.platform === 'linux')('NodeProcessControl on Linux', probeCases)
