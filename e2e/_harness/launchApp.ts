import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolveEntry, type AppEntry } from './resolveEntry.ts'

/**
 * `launchApp`: one E2E case's app under an isolated profile (testing strategy `17` §1.9).
 *
 * - The **built** app (`pnpm build`, the `electron-vite build` output in `out/`) starts through
 *   Playwright's `_electron`. `entry` picks the main file (`resolveEntry.ts`).
 * - A fresh `userData` in a `mkdtemp` folder, passed with Chromium's `--user-data-dir`, so the
 *   app's single-instance lock and data (and, once a Host exists, `hostDataDir` and the
 *   profile-keyed Host endpoint, ADR-002 D2) never meet the developer's own app.
 * - The E2E build profile is build-time data (`17` §1.9): the lane builds with
 *   `DWARFAI_BUILD_PROFILE=e2e` (`docs/e2e.md`); nothing here changes what the build contains.
 * - `stubs`, when given, is prepended to `PATH`, so detection and spawn resolve the stub CLIs
 *   first (the stub kit is later: ISSUE-313); temp `CLAUDE_CONFIG_DIR` and `CODEX_HOME` keep the
 *   app away from the developer's provider data.
 * - `launchApp` returns once the first window has loaded its page, so no case quits a half-started app.
 * - `teardown()` quits the app, waits for its process to exit and removes the temp profile, all
 *   within a quit budget (`quitTimeoutMs`, default 15 s). An app still running at the end of it is
 *   killed with its process tree and the teardown fails with that, so a quit that never finishes
 *   is a visible failure, never a test plus worker timeout that leaves the app running. The
 *   Stop-everything teardown for a case that leaves a Host running comes later: ISSUE-056.
 *
 * No production code knows about this harness (R14): everything goes through the command line,
 * the environment and Playwright's own main-process `evaluate`.
 */

export interface IsolatedProfile {
  /** The `mkdtemp` folder holding the whole profile; removed by `teardown()`. */
  readonly root: string
  readonly userDataDir: string
  readonly claudeConfigDir: string
  readonly codexHome: string
}

export interface LaunchOptions {
  /** `'current'` (default): the build's Electron main entry; `'ui-main'`: the UI-main target. */
  readonly entry?: AppEntry
  /** A directory of stub CLIs to prepend to the app's `PATH`. */
  readonly stubs?: string
  /** Extra environment for the app, applied last. */
  readonly env?: Readonly<Record<string, string>>
  /** Where `teardown()` saves the Playwright trace (a case's output folder keeps it on failure). */
  readonly tracePath?: string
  /** How long `teardown()` lets the app quit on its own before it kills the app's process tree. */
  readonly quitTimeoutMs?: number
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly window: Page
  readonly profile: IsolatedProfile
  /** Quits the app and removes the temp profile; a second call does nothing. */
  teardown(): Promise<void>
}

/** The app folder: the repository root, holding `package.json` and the build output `out/`. */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Variables of the test runner's environment that would change how Electron itself starts. */
const DROPPED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'])

function createProfile(): IsolatedProfile {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-'))
  const profile = {
    root,
    userDataDir: path.join(root, 'userData'),
    claudeConfigDir: path.join(root, 'claude'),
    codexHome: path.join(root, 'codex')
  }
  for (const dir of [profile.userDataDir, profile.claudeConfigDir, profile.codexHome])
    mkdirSync(dir)
  return profile
}

/**
 * The app's environment: the runner's, minus Electron start-up switches, with the stub directory
 * first on `PATH` (whatever its spelling on Windows) and the provider homes in the profile.
 */
function appEnv(profile: IsolatedProfile, options: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !DROPPED_ENV.has(key.toUpperCase())) env[key] = value
  }
  if (options.stubs !== undefined) {
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
    const current = pathKeys.map((key) => env[key]).find((value) => value !== '') ?? ''
    for (const key of pathKeys) delete env[key]
    env[pathKeys[0] ?? 'PATH'] =
      current === '' ? options.stubs : options.stubs + path.delimiter + current
  }
  env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir
  env.CODEX_HOME = profile.codexHome
  return { ...env, ...options.env }
}

/** A started app quits in well under a second on every OS; this is the bound, not the expectation. */
const DEFAULT_QUIT_TIMEOUT_MS = 15_000

/** How long a killed process tree, and the Playwright close behind it, get to be gone. */
const KILL_TIMEOUT_MS = 10_000

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Whether the child exits within `ms`. */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(hasExited(child))
    }, ms)
    child.once('exit', onExit)
  })
}

/** Waits for `promise` for at most `ms`; the teardown never waits unbounded on Playwright. */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

/**
 * Kills the launched app and every process it started, by the identity of the app's own process:
 * the child this runner spawned and has not seen exit, so its pid still names it (Node holds its
 * handle on Windows and has not reaped it on POSIX). Never a pid read from a listing.
 *
 * The whole tree, not the child alone: on Windows the process Playwright spawns is not the app's
 * browser process but its parent, so killing only the child leaves the app running, orphaned
 * (observed with Electron 44: the browser process, parent of the GPU and renderer helpers, is a
 * child of the spawned one).
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || hasExited(child)) return
  try {
    if (process.platform === 'win32') {
      // `/T` walks the tree down from the app's pid; `shell` stays off.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: KILL_TIMEOUT_MS
      })
    } else {
      // Playwright starts the app as the leader of its own process group (`detached` on POSIX),
      // so the negative pid ends the app and its helpers, and nothing else.
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // The tree may have exited meanwhile; the caller checks the exit, so a failed kill is seen.
    child.kill('SIGKILL')
  }
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const { main } = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
    main: string
  }
  const mainFile = resolveEntry(options.entry, APP_DIR, { main })
  const profile = createProfile()
  const removeProfile = async (): Promise<void> => {
    const deadline = Date.now() + KILL_TIMEOUT_MS
    for (;;) {
      try {
        rmSync(profile.root, { recursive: true, force: true })
        return
      } catch (error) {
        // Windows frees a killed tree's open files a moment after the app exits (EPERM, EBUSY).
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  let app: ElectronApplication
  try {
    app = await _electron.launch({
      // The current entry starts from the app folder, as the packaged app does, so Electron reads
      // `package.json` (name, `main`) and `app.getAppPath()` is the app folder. Before the cut-0
      // switch the ui-main target is not `main` yet, so it starts from its file.
      args: [
        options.entry === 'ui-main' ? mainFile : APP_DIR,
        `--user-data-dir=${profile.userDataDir}`
      ],
      cwd: APP_DIR,
      env: appEnv(profile, options)
    })
  } catch (error) {
    await removeProfile()
    throw error
  }
  if (options.tracePath !== undefined) {
    await app.context().tracing.start({ screenshots: true, snapshots: true })
  }

  let tornDown = false
  const teardown = async (): Promise<void> => {
    if (tornDown) return
    tornDown = true
    const child = app.process()
    const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS
    let quitError: unknown
    // Playwright's `close()` is `app.quit()` and then an unbounded wait for the process to exit,
    // so the budget runs beside it instead of after it.
    const quit = (async () => {
      if (options.tracePath !== undefined) {
        await app.context().tracing.stop({ path: options.tracePath })
      }
      await app.close()
    })().catch((error: unknown) => {
      quitError = error
    })
    let failure: unknown
    try {
      if (!(await waitForExit(child, quitTimeoutMs))) {
        killProcessTree(child)
        if (!(await waitForExit(child, KILL_TIMEOUT_MS))) {
          throw new Error(`the app (pid ${child.pid}) survived a kill of its process tree`)
        }
        await settleWithin(quit, KILL_TIMEOUT_MS)
        // Killed, so nothing is left behind, but a quit that never finishes is a defect: the case
        // fails with it instead of hanging until the test and worker timeouts.
        throw new Error(
          `the app (pid ${child.pid}) did not exit within ${quitTimeoutMs} ms of app.quit(); ` +
            'its process tree was killed',
          { cause: quitError }
        )
      }
      await settleWithin(quit, KILL_TIMEOUT_MS)
      if (quitError !== undefined) throw quitError
    } catch (error) {
      failure = error
    }
    try {
      await removeProfile()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  try {
    const window = await app.firstWindow()
    // The first window is created before its page loads (the legacy entry loads it last, after
    // every IPC handler is registered). A case starts from a started app, so it never quits one
    // whose page is still loading, which is not a state a person quits from.
    await window.waitForLoadState('load')
    return { app, window, profile, teardown }
  } catch (error) {
    await teardown()
    throw error
  }
}
