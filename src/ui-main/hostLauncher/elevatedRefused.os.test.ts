// L8 OS lane (17 §1.8; ADR-002 D6; 07 S12.03; 13 FM-011): the real Host of this checkout refuses an elevated start
// with ELEVATED_REFUSED, before it binds anything. The Host is `out/host/main.js` (testing/realHost.ts builds it),
// started as the launcher starts it, on the installed Electron with ELECTRON_RUN_AS_NODE=1.
//
// What each lane can prove for real, without elevating the lane itself:
// - Windows. The OS lane runs as a standard user (CI: scripts/ci/run-unelevated.mjs), and no process can raise its
//   own integrity, so the high-integrity branch cannot be reached here. What is real: the Host's fail-closed branch.
//   Its elevation is read from System32's `whoami.exe` by path under SystemRoot (privilege.ts); with SystemRoot naming
//   a folder that has no System32, the real read fails on the real OS, and the real Host must refuse with exit 65 and
//   bind nothing, exactly as for an elevated token. The same Host with the real SystemRoot is not refused (the test
//   user's medium token, read for real). The label-to-refusal rule itself is L1 (privilege.test.ts) and the refusal
//   step L2 (bootSteps.test.ts); privilege.os.test.ts reads the real label.
// - macOS and Linux. Elevation is read in-process (effective uid root, launched by a non-root user), so there is no
//   read to fail: the real branch needs a real root start. Where passwordless `sudo` is available on CI (GitHub's
//   hosted runners), the Host is started through `sudo -n`, which runs it as root with SUDO_UID naming the runner
//   user, and must refuse with exit 65. Without it, that case cannot run on the lane and says so.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_EXIT_CODES } from './hostExitCodes'
import { buildRealHost, startRealHost } from './testing/realHost'

const WINDOWS = process.platform === 'win32'
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const CASE_TIMEOUT_MS = 180_000
/** A refusing Host exits within its boot's first step; this bounds a Host that does not. */
const REFUSAL_BUDGET_MS = 30_000

/** Passwordless sudo, on CI only: never a root process on a developer's machine. */
const SUDO =
  !WINDOWS &&
  process.env.CI === 'true' &&
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0

let entry = ''
let root = ''

beforeAll(async () => {
  entry = await buildRealHost()
  // On POSIX directly under /tmp, so the Host's socket path fits `sun_path` on macOS.
  root = WINDOWS
    ? mkdtempSync(path.join(tmpdir(), 'dwarfai-elevated-os-'))
    : mkdtempSync('/tmp/dwelev-')
}, CASE_TIMEOUT_MS)

afterAll(() => {
  // A Host started as root may have left root-owned files (its log) behind.
  if (SUDO) spawnSync('sudo', ['-n', 'rm', '-rf', root], { stdio: 'ignore', timeout: 30_000 })
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/**
 * A fresh Host data folder for one start, and on POSIX the home and runtime folders the Host's endpoint is named
 * under, so a real Host never meets the user's own endpoint.
 */
function caseFolders(name: string): { dataDir: string; env: Record<string, string> } {
  const dataDir = path.join(root, name, 'host')
  mkdirSync(dataDir, { recursive: true })
  const env: Record<string, string> = WINDOWS
    ? {}
    : { HOME: path.join(root, name, 'home'), XDG_RUNTIME_DIR: path.join(root, name, 'xdg') }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { dataDir, env }
}

/** Starts `file args` and answers its exit code, or `'still running'` (then ends it) if it outlives the budget. */
function exitCodeOf(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<number | null | 'still running'> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { env, stdio: 'ignore', windowsHide: true, shell: false })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('still running')
    }, REFUSAL_BUDGET_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

/** Nothing of a bound Host is there: no identity file, no uiToken. */
function boundNothing(dataDir: string): void {
  expect(existsSync(path.join(dataDir, 'run', 'host.identity'))).toBe(false)
  expect(existsSync(path.join(dataDir, 'run', 'ui.token'))).toBe(false)
}

describe.runIf(WINDOWS)('ELEVATED_REFUSED on Windows', () => {
  it(
    '[ADR-002, S12.03, FM-011] the real Host whose elevation cannot be read refuses to start with ELEVATED_REFUSED and binds nothing',
    async () => {
      const { dataDir } = caseFolders('unreadable')
      const noSystem = path.join(root, 'no-system-root')
      mkdirSync(noSystem, { recursive: true })
      // Windows reads environment names case-insensitively: replace whichever spelling this process carries.
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'systemroot')
      )

      const code = await exitCodeOf(ELECTRON, [entry], {
        ...env,
        SystemRoot: noSystem,
        ELECTRON_RUN_AS_NODE: '1',
        DWARFAI_HOST_DATA_DIR: dataDir
      })

      expect(code).toBe(HOST_EXIT_CODES.ELEVATED_REFUSED)
      boundNothing(dataDir)
    },
    CASE_TIMEOUT_MS
  )

  it(
    '[ADR-002, S12.04] the same Host started by the standard test user, its elevation read for real, is not refused',
    async () => {
      const { dataDir, env } = caseFolders('standard')
      const host = await startRealHost({ entry, hostDataDir: dataDir, env })
      try {
        expect(host.alive).toBe(true)
        expect(existsSync(path.join(dataDir, 'run', 'host.identity'))).toBe(true)
      } finally {
        await host.kill()
      }
    },
    CASE_TIMEOUT_MS
  )
})

describe.runIf(!WINDOWS)('ELEVATED_REFUSED on POSIX', () => {
  it.runIf(SUDO)(
    '[ADR-002, S12.03, FM-011] the real Host started as root by a non-root user (sudo) refuses to start with ELEVATED_REFUSED and binds nothing',
    async () => {
      const { dataDir, env } = caseFolders('root')

      const code = await exitCodeOf(
        'sudo',
        [
          '-n',
          '/usr/bin/env',
          'ELECTRON_RUN_AS_NODE=1',
          `DWARFAI_HOST_DATA_DIR=${dataDir}`,
          ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
          ELECTRON,
          entry
        ],
        process.env
      )

      expect(code).toBe(HOST_EXIT_CODES.ELEVATED_REFUSED)
      boundNothing(dataDir)
    },
    CASE_TIMEOUT_MS
  )

  it(
    '[ADR-002, S12.04] the same Host started by the non-root test user is not refused',
    async ({ annotate }) => {
      if (!SUDO)
        await annotate('no passwordless sudo on this lane: the root start above did not run')
      const { dataDir, env } = caseFolders('standard')
      const host = await startRealHost({ entry, hostDataDir: dataDir, env })
      try {
        expect(host.alive).toBe(true)
      } finally {
        await host.kill()
      }
    },
    CASE_TIMEOUT_MS
  )
})
