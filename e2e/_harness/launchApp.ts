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
 * - `teardown()` quits the app, waits for its process to exit and removes the temp profile. The
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

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const { main } = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
    main: string
  }
  const mainFile = resolveEntry(options.entry, APP_DIR, { main })
  const profile = createProfile()
  const removeProfile = (): void =>
    rmSync(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

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
    removeProfile()
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
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      if (options.tracePath !== undefined) {
        await app.context().tracing.stop({ path: options.tracePath })
      }
      await app.close()
      await exited
    } finally {
      removeProfile()
    }
  }

  try {
    return { app, window: await app.firstWindow(), profile, teardown }
  } catch (error) {
    await teardown()
    throw error
  }
}
