// L8 OS lane (17 §1.8): the fake Host stub of fixtures/bin/fake-host as a real process, started as
// the launcher starts it (Electron with ELECTRON_RUN_AS_NODE=1). The launcher's OS-lane tests
// (detach, versionedCopy, upgrade) drive it through production code that keeps no stdio, so two
// properties of the stub itself are pinned here:
//
// - a stub that fails says why in its data folder, where those tests can read it;
// - a stub started where the previous boot's `run/ui.token` is still open for reading — a UI's
//   readiness probe reads it right after its connect succeeds, which is right when the new Host
//   rotates it (ADR-003 item 3) — still rotates the token and serves. On Windows a file removed with
//   `fs.rmSync` under Electron's Node stays "delete pending" while that reader holds it, and the
//   exclusive create that follows fails with EPERM: the cause of the upgrade.os.test.ts failures on
//   the Windows CI leg (exit 70).
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const WINDOWS = process.platform === 'win32'
const FAKE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-host.cjs')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
/** An Electron-as-Node start plus a bind and two small writes: a second here, a few on a loaded runner. */
const STUB_START_MS = 20_000
const CASE_TIMEOUT_MS = 60_000
/** Where the stub records why it failed (fake-host.cjs `fail`). */
const ERRORS_FILE = 'fake-host-errors.log'

/** Run after each case, last registered first: every stub is ended before its folder is removed. */
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function dataDir(): string {
  // On POSIX directly under /tmp, so the socket path fits sun_path on macOS.
  const root = WINDOWS
    ? mkdtempSync(path.join(tmpdir(), 'dwarfai-fakehost-'))
    : mkdtempSync('/tmp/dwfh-')
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  )
  const dir = path.join(root, 'host')
  mkdirSync(dir, { recursive: true })
  return dir
}

function endpointIn(dir: string): string {
  return WINDOWS
    ? `\\\\.\\pipe\\dwarfai-test-fakehost-${randomBytes(8).toString('hex')}`
    : path.join(path.dirname(dir), 'run', 'host.sock')
}

/** Starts the stub as the launcher does; it is killed after the case whatever happens. */
function startStub(hostDataDir: string): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(ELECTRON, [FAKE_HOST], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DWARFAI_HOST_DATA_DIR: hostDataDir },
    stdio: 'ignore',
    windowsHide: true
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', () => resolve(null))
  })
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  return { child, exited }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves 'serving' once the stub wrote its report (after its bind and token), or its exit code. */
async function servingOrExit(
  hostDataDir: string,
  exited: Promise<number | null>
): Promise<'serving' | { exitCode: number | null }> {
  let exit: { exitCode: number | null } | null = null
  void exited.then((exitCode) => (exit = { exitCode }))
  for (let waited = 0; waited < STUB_START_MS; waited += 50) {
    if (readdirSync(hostDataDir).some((name) => /^fake-host-\d+\.json$/.test(name)))
      return 'serving'
    if (exit !== null) return exit
    await sleep(50)
  }
  return { exitCode: null }
}

function errorsIn(hostDataDir: string): string {
  const file = path.join(hostDataDir, ERRORS_FILE)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

describe('the fake Host stub as a real process (17 §1.8)', () => {
  it(
    '[ADR-002] a fake Host that cannot start exits 70 and writes its reason to fake-host-errors.log in its data folder',
    async () => {
      const hostDataDir = dataDir()
      writeFileSync(path.join(hostDataDir, 'fake-host.json'), '{ not json')

      const { exited } = startStub(hostDataDir)

      expect(await exited).toBe(70)
      expect(errorsIn(hostDataDir)).toMatch(/^fake-host: SyntaxError/m)
    },
    CASE_TIMEOUT_MS
  )

  it(
    "[ADR-003] a fake Host started while the previous boot's ui.token is open for reading rotates the token and serves",
    async () => {
      const hostDataDir = dataDir()
      const runDir = path.join(hostDataDir, 'run')
      mkdirSync(runDir, { recursive: true })
      const tokenFile = path.join(runDir, 'ui.token')
      writeFileSync(tokenFile, 'previous-boot')
      writeFileSync(
        path.join(hostDataDir, 'fake-host.json'),
        JSON.stringify({
          endpoint: endpointIn(hostDataDir),
          mode: 'ready',
          maxLifeMs: CASE_TIMEOUT_MS
        })
      )
      // A UI's readiness probe reading the previous token, held across the stub's whole boot.
      const reader = openSync(tokenFile, 'r')
      try {
        const { exited } = startStub(hostDataDir)

        const outcome = await servingOrExit(hostDataDir, exited)

        expect(outcome, errorsIn(hostDataDir)).toBe('serving')
      } finally {
        closeSync(reader)
      }
      expect(readFileSync(tokenFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    },
    CASE_TIMEOUT_MS
  )
})
