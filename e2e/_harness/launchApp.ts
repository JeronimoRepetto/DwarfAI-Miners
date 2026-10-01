import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
 *   is a visible failure, never a test plus worker timeout that leaves the app running.
 * - From cut 0 the app starts a DwarfAI Host for its profile, which never exits on its own (OQ-63).
 *   `teardown({ stopEverything: true })` ends it the way a person does: the app's own Stop
 *   everything and quit (A-N34, then Confirm in the window's confirmation), after which the app
 *   exits with its Host; a Host or an app still running after it fails the teardown (ISSUE-056,
 *   review R7V-01). A plain `teardown()` quits the app and then ends a Host the profile still runs,
 *   by the pid of its `run/host.identity`, so no case leaves one behind.
 * - The Host's versioned copy (ADR-002 D5) is made under the profile too: LOCALAPPDATA (Windows),
 *   XDG_DATA_HOME (Linux) or HOME (macOS, a short folder under /tmp so its socket path fits) point
 *   into it unless `env` names them.
 * - Electron's `-r` switch preloads `mainErrorGuard.cjs` before the app's main file runs, so an
 *   uncaught exception while it loads ends the app with its stack recorded, never a modal box.
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
  /** Where the app's per-user data root points (the Host's versioned copy): inside `root`, or a /tmp folder on macOS. */
  readonly dataRoot: string
}

export interface LaunchOptions {
  /** `'current'` (default): the build's Electron main entry; `'ui-main'`: the UI-main target. */
  readonly entry?: AppEntry
  /**
   * The app folder to launch (default: this repository). The legacy seam-A replay records on another build's folder,
   * the pre-cut build (`scripts/strangler/record-seam-a.mjs`).
   */
  readonly appDir?: string
  /** A directory of stub CLIs to prepend to the app's `PATH`. */
  readonly stubs?: string
  /**
   * With `stubs`, the app's `PATH` is `stubs` alone, nothing of the runner's: the legacy seam-A replay detects the same
   * CLIs on every machine (`scripts/strangler/seamAReplay.ts`).
   */
  readonly pathOnly?: boolean
  /** Preloads `trayProbe.cjs`, so the case can choose a tray item and see the icon shown and removed. */
  readonly trayProbe?: boolean
  /** Writes a case's fixture data into the fresh profile before the app starts. */
  readonly beforeLaunch?: (profile: IsolatedProfile) => Promise<void>
  /** Extra environment for the app, applied last; a function gets the profile, to point a variable into it. */
  readonly env?:
    | Readonly<Record<string, string>>
    | ((profile: IsolatedProfile) => Readonly<Record<string, string>>)
  /** Where `teardown()` saves the Playwright trace (a case's output folder keeps it on failure). */
  readonly tracePath?: string
  /** How long `teardown()` lets the app quit on its own before it kills the app's process tree. */
  readonly quitTimeoutMs?: number
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly window: Page
  readonly profile: IsolatedProfile
  /**
   * Quits the app, ends the profile's Host and removes the temp profile; a second call does nothing. With
   * `stopEverything`, the app's own Stop everything and quit ends the Host and the app, and anything left running
   * fails the teardown.
   */
  teardown(options?: TeardownOptions): Promise<void>
}

export interface TeardownOptions {
  /** End the profile's Host and the app through the app's own Stop everything and quit (ISSUE-056). */
  readonly stopEverything?: boolean
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
    codexHome: path.join(root, 'codex'),
    // On macOS the Host's socket lives under HOME, and a path under the per-user temp folder is too long for it.
    dataRoot: process.platform === 'darwin' ? mkdtempSync('/tmp/dwe-') : path.join(root, 'data')
  }
  for (const dir of [profile.userDataDir, profile.claudeConfigDir, profile.codexHome])
    mkdirSync(dir)
  if (process.platform !== 'darwin') mkdirSync(profile.dataRoot)
  return profile
}

/** The variable naming the per-user data root the Host's versioned copy goes under, per OS (versionedCopyRoot.ts). */
function dataRootVariable(): string {
  if (process.platform === 'win32') return 'LOCALAPPDATA'
  return process.platform === 'darwin' ? 'HOME' : 'XDG_DATA_HOME'
}

/** The preload that keeps an uncaught exception during the main file's load from opening a modal box. */
const MAIN_ERROR_GUARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'mainErrorGuard.cjs'
)

/** The preload that records the app's tray menus and icon (`trayProbe.cjs`). */
const TRAY_PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'trayProbe.cjs')

/** Where, inside the profile, the tray probe notes the icon shown and removed. */
const TRAY_LOG_FILE = 'tray.log'

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
      current === '' || options.pathOnly === true
        ? options.stubs
        : options.stubs + path.delimiter + current
  }
  env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir
  env.CODEX_HOME = profile.codexHome
  env[dataRootVariable()] = profile.dataRoot
  env.DWARFAI_E2E_MAIN_ERRORS = path.join(profile.root, MAIN_ERRORS_FILE)
  if (options.trayProbe === true) env.DWARFAI_E2E_TRAY_LOG = path.join(profile.root, TRAY_LOG_FILE)
  const extra = typeof options.env === 'function' ? options.env(profile) : options.env
  return { ...env, ...extra }
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

/** How long the main process gets to answer the diagnosis of a quit that ran out of budget. */
const DIAGNOSIS_ANSWER_MS = 3_000

/** How long macOS `sample` records the stuck app's threads, in seconds. */
const SAMPLE_SECONDS = 3

/**
 * What the app still is when its quit ran out of budget, for the failure message:
 *
 * - the main process's own answer (its windows and web contents): windows that are not destroyed
 *   mean the quit was turned down or never ran; all destroyed means it stalled after closing them;
 *   no answer means the main thread is blocked or its Node environment is already gone;
 * - on macOS, a `sample` of every thread's native stack, written next to the case's trace, which
 *   shows where a blocked main thread sits.
 */
async function diagnoseStuckQuit(
  app: ElectronApplication,
  child: ChildProcess,
  tracePath: string | undefined
): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const answer = await Promise.race([
    app
      .evaluate(({ app: electronApp, BrowserWindow, webContents }) =>
        JSON.stringify({
          ready: electronApp.isReady(),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            destroyed: window.isDestroyed(),
            visible: !window.isDestroyed() && window.isVisible()
          })),
          webContents: webContents.getAllWebContents().length
        })
      )
      .then(
        (state) => `the main process answered: ${state}`,
        (error: unknown) => `the main process could not answer: ${String(error)}`
      ),
    new Promise<string>((resolve) => {
      timer = setTimeout(
        () => resolve(`the main process did not answer within ${DIAGNOSIS_ANSWER_MS} ms`),
        DIAGNOSIS_ANSWER_MS
      )
    })
  ])
  clearTimeout(timer)
  if (process.platform !== 'darwin' || tracePath === undefined || child.pid === undefined) {
    return answer
  }
  const samplePath = path.join(path.dirname(tracePath), 'quit-sample.txt')
  const sampled = await new Promise<string>((resolve) => {
    // `sample` ships with macOS; shell stays off.
    execFile(
      'sample',
      [String(child.pid), String(SAMPLE_SECONDS), '-file', samplePath],
      { timeout: KILL_TIMEOUT_MS },
      (error) => resolve(error ? `sample failed: ${error.message}` : `thread sample: ${samplePath}`)
    )
  })
  return `${answer}; ${sampled}`
}

/** Where, inside the profile, the main process's uncaught exceptions are written. */
const MAIN_ERRORS_FILE = 'main-errors.log'

/**
 * Takes Electron's own `uncaughtException` handling out of the launched app and records every
 * uncaught exception in `file` instead.
 *
 * Electron's default handler opens a modal "A JavaScript error occurred in the main process" box,
 * which blocks the main thread until someone clicks it: an app quit on macOS hung exactly there,
 * `-[NSAlert runModal]` called from a microtask (the thread sample of PR #1122). A test-launched
 * app must never open a modal, and the exception is the defect, so the teardown fails with its
 * stack instead. Installed through Playwright's main-process `evaluate`, never production code.
 */
async function captureMainProcessErrors(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate((_electron, errorsFile) => {
    const fs = process.getBuiltinModule('node:fs')
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', (error: unknown, origin: string) => {
      const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error)
      fs.appendFileSync(
        errorsFile,
        `[${origin}] ${stack}
`
      )
    })
    // Lets a harness self-test tell that the capture is in place.
    ;(globalThis as { __dwarfaiE2eMainErrors?: string }).__dwarfaiE2eMainErrors = errorsFile
  }, file)
}

/** The uncaught exceptions the main process recorded, or `undefined` when there were none. */
function readMainErrors(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  const recorded = readFileSync(file, 'utf8').trim()
  return recorded === '' ? undefined : recorded
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const appDir = options.appDir ?? APP_DIR
  const { main } = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as {
    main: string
  }
  const mainFile = resolveEntry(options.entry, appDir, { main })
  const profile = createProfile()
  /**
   * Removes the profile, and first ends every process still naming its folders: on Windows the browser process can
   * outlive the process Playwright spawned and write its profile files after that one exited, and a Host that was
   * starting when the app quit writes its run files late. Checked again a moment later, so nothing comes back.
   */
  const removeProfile = async (): Promise<void> => {
    const deadline = Date.now() + KILL_TIMEOUT_MS
    for (;;) {
      try {
        for (const pid of [
          ...processesNaming(profile.root),
          ...processesNaming(profile.dataRoot)
        ]) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Gone meanwhile.
          }
        }
        rmSync(profile.root, { recursive: true, force: true })
        rmSync(profile.dataRoot, { recursive: true, force: true })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        const left =
          existsSync(profile.root) ||
          existsSync(profile.dataRoot) ||
          processesNaming(profile.root).length > 0
        if (!left) return
        if (Date.now() >= deadline) throw new Error(`the profile ${profile.root} keeps coming back`)
      } catch (error) {
        // Windows frees a killed tree's open files a moment after the app exits (EPERM, EBUSY).
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  let app: ElectronApplication
  try {
    // A case's fixture data goes into the profile before the app reads it.
    await options.beforeLaunch?.(profile)
    app = await _electron.launch({
      // The current entry starts from the app folder, as the packaged app does, so Electron reads
      // `package.json` (name, `main`) and `app.getAppPath()` is the app folder. Before the cut-0
      // switch the ui-main target is not `main` yet, so it starts from its file.
      args: [
        '-r',
        MAIN_ERROR_GUARD,
        ...(options.trayProbe === true ? ['-r', TRAY_PROBE] : []),
        options.entry === 'ui-main' ? mainFile : appDir,
        `--user-data-dir=${profile.userDataDir}`
      ],
      cwd: appDir,
      env: appEnv(profile, options)
    })
  } catch (error) {
    await removeProfile()
    throw error
  }
  // Held from the launch: an app that already exited on its own (from cut 0, Stop everything and quit ends it when its
  // Host closes, ADR-002 D7 step 4) still has its process for the teardown to read.
  const appProcess = app.process()
  const mainErrorsFile = path.join(profile.root, MAIN_ERRORS_FILE)
  await captureMainProcessErrors(app, mainErrorsFile)
  if (options.tracePath !== undefined) {
    await app.context().tracing.start({ screenshots: true, snapshots: true })
  }

  let tornDown = false
  let firstWindow: Page | undefined
  const teardown = async (teardownOptions: TeardownOptions = {}): Promise<void> => {
    if (tornDown) return
    tornDown = true
    const child = appProcess
    const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS
    const hostPid = profileHostPid(profile.userDataDir)
    if (teardownOptions.stopEverything === true) {
      await teardownThroughStopEverything(app, child, firstWindow, profile, quitTimeoutMs, hostPid)
      return
    }
    let quitError: unknown
    // The harness sends `app.quit()` itself instead of Playwright's `close()`, which drops its
    // connection to the main process at once and then waits, unbounded, for the exit. Keeping the
    // connection lets a quit that runs out of budget be asked what state the app is in.
    const quit = (async () => {
      if (options.tracePath !== undefined) {
        await app.context().tracing.stop({ path: options.tracePath })
      }
      await app.evaluate(({ app: electronApp }) => {
        electronApp.quit()
      })
    })().catch((error: unknown) => {
      // An app that exits while answering ends the call with a closed connection: not a failure.
      if (!hasExited(child)) quitError = error
    })
    let failure: unknown
    try {
      if (!(await waitForExit(child, quitTimeoutMs))) {
        const diagnosis = await diagnoseStuckQuit(app, child, options.tracePath)
        killProcessTree(child)
        if (!(await waitForExit(child, KILL_TIMEOUT_MS))) {
          throw new Error(`the app (pid ${child.pid}) survived a kill of its process tree`)
        }
        await settleWithin(quit, KILL_TIMEOUT_MS)
        await settleWithin(app.close(), KILL_TIMEOUT_MS)
        // Killed, so nothing is left behind, but a quit that never finishes is a defect: the case
        // fails with it instead of hanging until the test and worker timeouts.
        throw new Error(
          `the app (pid ${child.pid}) did not exit within ${quitTimeoutMs} ms of app.quit(); ` +
            `its process tree was killed. ${diagnosis}`,
          { cause: quitError }
        )
      }
      await settleWithin(quit, KILL_TIMEOUT_MS)
      // Releases Playwright's side of the exited app; it no longer waits on anything.
      await settleWithin(app.close(), KILL_TIMEOUT_MS)
      if (quitError !== undefined) throw quitError
    } catch (error) {
      failure = error
    }
    // A plain quit leaves the profile's Host running, as it leaves a person's (OQ-63): the harness ends it.
    endHost(hostPid ?? profileHostPid(profile.userDataDir))
    const mainErrors = readMainErrors(mainErrorsFile)
    if (mainErrors !== undefined) {
      failure = new Error(
        `uncaught exception in the main process: ${mainErrors}` +
          (failure === undefined ? '' : `; then: ${(failure as Error).message}`),
        { cause: failure }
      )
    }
    try {
      await removeProfile()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  async function teardownThroughStopEverything(
    launchedApp: ElectronApplication,
    child: ChildProcess,
    window: Page | undefined,
    isolated: IsolatedProfile,
    budgetMs: number,
    knownHostPid: number | null
  ): Promise<void> {
    let failure: unknown
    try {
      if (window === undefined)
        throw new Error('the app has no window to run Stop everything and quit from')
      // Stop everything and quit asks the Host: it is offered once the UI attached to it (S10.18 guard).
      await waitForHostAttached(isolated)
      await stopEverythingFromWindow(window)
      if (!(await waitForExit(child, budgetMs))) {
        const diagnosis = await diagnoseStuckQuit(launchedApp, child, options.tracePath)
        killProcessTree(child)
        await waitForExit(child, KILL_TIMEOUT_MS)
        throw new Error(
          `the app (pid ${child.pid}) did not exit within ${budgetMs} ms of Stop everything and quit; ` +
            `its process tree was killed. ${diagnosis}`
        )
      }
      await settleWithin(launchedApp.close(), KILL_TIMEOUT_MS)
      const hostPid = knownHostPid ?? profileHostPid(isolated.userDataDir)
      if (hostPid !== null && (await stillAlive(hostPid, budgetMs))) {
        endHost(hostPid)
        throw new Error(`Stop everything and quit left the profile's Host (pid ${hostPid}) running`)
      }
    } catch (error) {
      failure = error
      endHost(knownHostPid ?? profileHostPid(isolated.userDataDir))
    }
    const mainErrors = readMainErrors(mainErrorsFile)
    if (mainErrors !== undefined) {
      failure = new Error(`uncaught exception in the main process: ${mainErrors}`, {
        cause: failure
      })
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
    firstWindow = window
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

/** The pid of the Host the profile runs, from its `run/host.identity` (ADR-002 D2), or `null` when none runs. */
export function profileHostPid(userDataDir: string): number | null {
  const file = path.join(userDataDir, 'host', 'run', 'host.identity')
  if (!existsSync(file)) return null
  try {
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Whether the process `pid` runs (EPERM: it runs, under another user). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether `pid` still runs after up to `ms`. */
async function stillAlive(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** Ends the test profile's Host, the harness's own cleanup (a test process, never a person's). */
function endHost(pid: number | null): void {
  if (pid === null || !isProcessAlive(pid)) return
  try {
    process.kill(pid)
  } catch {
    // Gone meanwhile.
  }
}

/** The confirm button of the window's Stop everything and quit confirmation (ISSUE-317; the design's copy marker). */
const CONFIRM_BUTTON = /confirm button naming the count/

/**
 * Stop everything and quit as a person runs it from the window: the window asks for the tray item's flow (A-N34),
 * UI main pushes the confirmation (A-N25) and the person confirms it (A-N26).
 */
export async function stopEverythingFromWindow(window: Page): Promise<void> {
  await window.evaluate(() => {
    ;(window as unknown as { api: { requestStopEverything(): void } }).api.requestStopEverything()
  })
  await window.getByRole('button', { name: CONFIRM_BUTTON }).click({ timeout: 30_000 })
}

/** What the tray probe saw: each icon shown and removed, in order (readable after the app exited). */
export function trayEvents(profile: IsolatedProfile): string[] {
  const file = path.join(profile.root, TRAY_LOG_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
}

/**
 * Chooses the item of the app's tray menu whose label contains `labelPart`, as a person's click on it does: the
 * item's own `click` of the last tray menu the app built (`trayProbe.cjs`). Throws when no such item is shown.
 */
export async function chooseTrayItem(app: ElectronApplication, labelPart: string): Promise<void> {
  await app.evaluate((_electron, part) => {
    type Entry = { label?: string; click?: () => void }
    const probe = (globalThis as { __dwarfaiE2eTray?: { menus: Entry[][] } }).__dwarfaiE2eTray
    if (probe === undefined) throw new Error('the app was not launched with the tray probe')
    const menu = [...probe.menus]
      .reverse()
      .find((template) => template.some((entry) => entry.label?.includes(part) === true))
    const item = menu?.find((entry) => entry.label?.includes(part) === true)
    if (item?.click === undefined) throw new Error(`the tray menu shows no item labelled ${part}`)
    item.click()
  }, labelPart)
}

/** The tray menu's labels, as design's copy markers name them (`window/application/trayMenu.ts`). */
export const TRAY_ITEMS = {
  open: 'open item label',
  quit: 'quit item label',
  stopEverything: 'stops every session the app launched and quits'
} as const

/**
 * The per-user folders of the app pointed into the profile (HOME, USERPROFILE, APPDATA, the XDG config and state
 * homes), for a case whose app must read none of the developer's own sessions, settings or provider data. Pass it as
 * `env`, alone or spread with others.
 *
 * On macOS HOME is the profile's short data root under /tmp, as `appEnv` already sets it: the Host's socket lives under
 * HOME (`endpoint.ts`, `~/Library/Application Support/<app>/run/host-<key>.sock`), and under the per-user temp folder
 * (`/var/folders/…/T/`) that path is longer than `sun_path`'s 104 bytes, so the Host refuses to bind (FM-037).
 */
export function homeIn(profile: IsolatedProfile): Record<string, string> {
  const home = process.platform === 'darwin' ? profile.dataRoot : path.join(profile.root, 'home')
  mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state')
  }
}

/** Waits until the profile's Host runs and the UI attached to it (19 §9.1 `host.connection` connected). */
export async function waitForHostAttached(
  profile: IsolatedProfile,
  timeoutMs = 90_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pid = profileHostPid(profile.userDataDir)
    const logs = path.join(profile.userDataDir, 'logs')
    const attached =
      existsSync(logs) &&
      readdirSync(logs)
        .filter((name) => name.startsWith('ui-'))
        .some((name) =>
          readFileSync(path.join(logs, name), 'utf8')
            .split(/\r?\n/)
            .some((line) => line.includes('"host.connection"') && line.includes('"connected"'))
        )
    if (pid !== null && isProcessAlive(pid) && attached) return pid
    if (Date.now() >= deadline)
      throw new Error(`the profile's Host did not start within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Whether any window of the app is on screen. */
export async function anyWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())
  )
}

/**
 * The pids of the processes whose command line or executable names `folder` (this runner and the query excluded): a
 * profile's own app processes and its Host, which runs from the versioned copy under the profile's data root. A test
 * profile's folder names only processes of its case, never a person's.
 */
export function processesNaming(folder: string): number[] {
  const needle = folder.toLowerCase()
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
    const quoted = needle.replaceAll("'", "''")
    const script =
      'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ' +
      `((($_.CommandLine) -and $_.CommandLine.ToLower().Contains('${quoted}')) -or ` +
      `(($_.ExecutablePath) -and $_.ExecutablePath.ToLower().Contains('${quoted}'))) } | ` +
      'ForEach-Object { $_.ProcessId }'
    const out = execFileSync(
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    )
    return out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30_000 })
  return out
    .split('\n')
    .filter((line) => line.toLowerCase().includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}
