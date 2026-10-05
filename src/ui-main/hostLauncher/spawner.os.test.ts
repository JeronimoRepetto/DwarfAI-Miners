// L8 OS lane (17 §1.3, §1.8): the HostSpawner contract on this OS's real spawner (ADR-002 D6): on Windows the launch
// helper's breakaway, or WMI where the job forbids it (`pnpm build:native` builds the helper); elsewhere a detached
// spawn in a new session. The processes are throwaway Node scripts, never a provider CLI (17 §1.8), and every one
// still running is ended after its case. The double and the seam runs are fakes/FakeHostSpawner.test.ts,
// windows.test.ts and posix.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, vi } from 'vitest'
import type { HostSpawnRequest } from './ports'
import { createPosixSpawner } from './posix'
import { IDENTITY_TOLERANCE_MS, createProcessStartReader } from './processStart'
import { runHostSpawnerContract, type SpawnScript } from './testing/hostSpawner.contract'
import { osQueryRunner, thisPlatform } from './testing/osQueryRunner'
import { loadWinLaunch } from './win-launch/nativeWinLaunch'
import { createWindowsSpawner } from './windows'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PREBUILDS = path.join(REPO_ROOT, 'prebuilds')
/** A kept-running script ends itself after this long, should a case fail to end it. */
const SCRIPT_LIFETIME_MS = 60_000

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The environment a request carries: this process's, as strings. */
function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/** Whether `pid` names a running process (signal 0 checks without signalling). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readStart = createProcessStartReader({ platform: thisPlatform(), runQuery: osQueryRunner() })

/**
 * Whether `pid` is still the script that wrote its pid file at `writtenAtMs` (ADR-014: never a bare
 * pid): it runs and started no later than that, within the one tolerance. Gone, started later or
 * unreadable is never the script, so it is never signalled.
 */
async function stillTheScript(pid: number, writtenAtMs: number): Promise<boolean> {
  const start = await readStart(pid)
  return start.kind === 'started' && start.ms <= writtenAtMs + IDENTITY_TOLERANCE_MS
}

runHostSpawnerContract(`the real ${process.platform} spawner`, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-spawner-os-'))
  const pidFile = path.join(root, 'kept.pid')
  const stopFile = path.join(root, 'stop')
  cleanups.push(async () => {
    writeFileSync(stopFile, '')
    const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : NaN)
    if (
      Number.isSafeInteger(pid) &&
      running(pid) &&
      (await stillTheScript(pid, statSync(pidFile).mtimeMs))
    ) {
      process.kill(pid)
    }
    // Windows keeps a folder that is a live process's working folder: wait for the process to be gone first.
    for (
      let waited = 0;
      Number.isSafeInteger(pid) && running(pid) && waited < 10_000;
      waited += 50
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const scripts: Record<Exclude<SpawnScript, 'cannot-start'>, string> = {
    'exits-with-3': 'setTimeout(() => process.exit(3), 200)',
    'keeps-running': [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      `setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0) }, 100)`,
      `setTimeout(() => process.exit(0), ${SCRIPT_LIFETIME_MS})`
    ].join('; ')
  }
  const request = (script: SpawnScript): HostSpawnRequest =>
    script === 'cannot-start'
      ? { file: path.join(root, 'no-such-host'), args: [], env: environment(), cwd: tmpdir() }
      : { file: process.execPath, args: ['-e', scripts[script]], env: environment(), cwd: tmpdir() }
  return Promise.resolve({
    spawner:
      process.platform === 'win32'
        ? createWindowsSpawner({ loadHelper: () => loadWinLaunch({ prebuildsDir: PREBUILDS }) })
        : createPosixSpawner(),
    request,
    afterLaunch: () => {},
    async stillRunning() {
      for (let waited = 0; !existsSync(pidFile) && waited < 15_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return running(Number(readFileSync(pidFile, 'utf8')))
    }
  })
})
