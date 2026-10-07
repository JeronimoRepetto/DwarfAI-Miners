import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  APP_DIAGNOSTICS_DIR,
  appEnv,
  createIsolatedProfile,
  killProcessTree,
  launchApp,
  waitForHostAttached,
  type LaunchedApp
} from './launchApp.ts'

/**
 * L9 smoke of the E2E harness itself (testing strategy `17` §1.9).
 *
 * Only what exists before cut 0 is asserted (review R7V-01): the built app starts under an isolated
 * profile, a stub directory prepended to `PATH` is what it resolves, and teardown leaves nothing
 * behind. The Host-endpoint case belongs to the attach issue (later: ISSUE-051) and the
 * Stop-everything teardown to the cut-0 switch (later: ISSUE-056). Assertions read the app's own
 * state through Playwright's main-process `evaluate`, never through a production backdoor.
 */

/** The app folder the harness launches (the repository root). */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** This harness folder (its test-only preloads live under fixtures/). */
const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url))

// The harness self-test runs once: a retry would hide a harness defect (17 §5.4).
test.describe.configure({ retries: 0 })

/** A stub directory holding one probe program with the given name, resolvable through `PATH`. */
function stubDirWithProbe(name: string): { dir: string; probe: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-stubs-'))
  const probe = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name)
  writeFileSync(probe, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
  if (process.platform !== 'win32') chmodSync(probe, 0o755)
  return { dir, probe }
}

/** Whether a process with this pid still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

test.describe('E2E harness (17 §1.9)', () => {
  let launched: LaunchedApp | undefined
  const tempDirs: string[] = []

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('[ADR-002] the built app starts under an isolated profile with a fresh userData and the first window shows', async () => {
    launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched

    expect(realpathSync(profile.root).startsWith(realpathSync(tmpdir()))).toBe(true)
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(realpathSync(userData)).toBe(realpathSync(profile.userDataDir))

    // The first window is the built renderer page, not a dev server. Today's app starts to the tray
    // with that window hidden until the tray, the shortcut or a second launch shows it (docs/e2e.md).
    await window.waitForLoadState('domcontentloaded')
    expect(window.url().startsWith('file:'), 'the window loads a built file').toBe(true)
    expect(realpathSync(fileURLToPath(window.url()))).toBe(
      realpathSync(path.join(APP_DIR, 'out', 'renderer', 'index.html'))
    )
    expect(await window.locator('body').count(), 'the page has a body').toBe(1)
  })

  test('[ADR-002] a stub directory prepended to PATH is what the launched app resolves', async () => {
    const { dir, probe } = stubDirWithProbe('dwarfai-e2e-probe')
    tempDirs.push(dir)
    launched = await launchApp({ stubs: dir, tracePath: test.info().outputPath('trace.zip') })

    const resolved = await launched.app.evaluate((_electron, name) => {
      const fs = process.getBuiltinModule('node:fs')
      const nodePath = process.getBuiltinModule('node:path')
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
      const extensions =
        process.platform === 'win32' ? (process.env.PATHEXT ?? '.CMD').split(';') : ['']
      const dirs = (process.env[pathKey] ?? '').split(nodePath.delimiter)
      for (const candidateDir of dirs) {
        for (const extension of extensions) {
          const candidate = nodePath.join(candidateDir, name + extension.toLowerCase())
          if (fs.existsSync(candidate)) return { first: dirs[0], found: candidate }
        }
      }
      return { first: dirs[0], found: null }
    }, 'dwarfai-e2e-probe')

    expect(resolved.first).toBe(dir)
    expect(resolved.found && realpathSync(resolved.found)).toBe(realpathSync(probe))
  })

  test('[ADR-002] teardown quits the app and leaves no app process and no temp profile behind', async () => {
    launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    const { app, profile } = launched
    const pids = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((metric) => metric.pid)
    )
    expect(pids.length, 'the app reports its processes').toBeGreaterThan(0)
    expect(readdirSync(profile.userDataDir).length, 'the app wrote its profile').toBeGreaterThan(0)

    await launched.teardown()
    launched = undefined

    expect(pids.filter(isAlive), 'app processes still running').toEqual([])
    expect(existsSync(profile.root), 'the temp profile is removed').toBe(false)
  })

  test("[ADR-002] teardown keeps the main process's timeline and the app's logs beside the trace, so a failed case shows what the app did", async () => {
    const tracePath = test.info().outputPath('trace.zip')
    launched = await launchApp({ tracePath })
    const { profile } = launched
    // The app has logged its Host attach (19 §9.1 `host.connection`) in its UI log.
    await waitForHostAttached(profile)

    await launched.teardown()
    launched = undefined

    expect(existsSync(profile.root), 'the temp profile is removed').toBe(false)
    const kept = path.join(path.dirname(tracePath), APP_DIAGNOSTICS_DIR)
    const timeline = path.join(kept, 'main-lifecycle.log')
    expect(existsSync(timeline), 'the main-process timeline is kept').toBe(true)
    const events = readFileSync(timeline, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { event: string; webContents?: number })
    // The window's page load from its start, then the quit the teardown asked for and the exit, in order.
    const names = events.map((entry) => entry.event)
    expect(names).toContain('did-start-loading')
    expect(names).toContain('did-stop-loading')
    expect(names.indexOf('before-quit')).toBeGreaterThan(names.lastIndexOf('did-stop-loading'))
    expect(names.indexOf('exit'), 'the exit is recorded after the quit').toBeGreaterThan(
      names.indexOf('before-quit')
    )
    // The app's own UI log segments (19 §9.1), which a teardown used to delete with the profile.
    expect(
      readdirSync(path.join(kept, 'logs')).some((name) => name.startsWith('ui-')),
      'the UI log is kept'
    ).toBe(true)
  })
})

test.describe('E2E harness: a bounded teardown (17 §1.9)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
  })

  test('[ADR-002] launchApp returns once the first window has finished loading, so a case never quits a half-loaded app', async () => {
    launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })

    const loading = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.webContents.isLoading())
    )
    expect(loading.length, 'the app has its window').toBeGreaterThan(0)
    expect(loading, 'no window is still loading its page').not.toContain(true)
  })

  test("[ADR-002] launchApp returns only once the main process, too, sees no window loading, even when main takes in the load's end late", async () => {
    // The injected delay: main is held busy from the page's `dom-ready`, so the renderer's `load` comes first, as on a
    // slow runner (run 37036544456, where the case above failed).
    launched = await launchApp({
      mainPreloads: [path.join(HARNESS_DIR, 'fixtures', 'slowMainLoadEnd.cjs')],
      tracePath: test.info().outputPath('trace.zip')
    })

    const loading = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.webContents.isLoading())
    )
    expect(loading.length, 'the app has its window').toBeGreaterThan(0)
    expect(loading, 'no window is still loading its page').not.toContain(true)
  })

  test('[ADR-002] an app that refuses to quit is killed with its process tree within the quit budget, and teardown says so', async () => {
    const current = await launchApp({
      quitTimeoutMs: 2_000,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, profile } = current
    // Held before teardown: Playwright refuses `app.process()` once the app is closed.
    const child = app.process()
    // The app's start is over first: until the UI attached to its Host, the start runs one synchronous step on the
    // main thread, the Host's breakaway launch (a CreateProcess of the fresh versioned copy on Windows: about 0.1 s
    // here, seconds on a stalling CI disk), and a diagnosis asked inside it gets no answer (run 37287673670: "the main
    // process did not answer within 3000 ms", the quit 40 ms after the page's load). The case asks a main process
    // that has nothing left to do, the responsive one its second assertion describes.
    await waitForHostAttached(profile)
    const pids = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((metric) => metric.pid)
    )
    // The app turns every quit down, as a wedged quit would look from outside.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.on('before-quit', (event) => event.preventDefault())
    })

    let guard: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        current.teardown().then(
          () => 'teardown resolved',
          (error: unknown) => (error as Error).message
        ),
        new Promise<string>((resolve) => {
          guard = setTimeout(() => resolve('teardown still running after 15 s'), 15_000)
        })
      ])

      expect(outcome).toMatch(/did not exit within 2000 ms of app\.quit\(\)/)
      // The failure carries what the main process still answered before the kill: here, a
      // responsive main whose window survived the quit, the signature of a quit turned down.
      expect(outcome).toMatch(/the main process answered: .*"destroyed":false/)
      await expect
        .poll(() => pids.filter(isAlive), {
          message: 'app processes still running',
          timeout: 10_000
        })
        .toEqual([])
      expect(existsSync(profile.root), 'the temp profile is removed').toBe(false)
    } finally {
      clearTimeout(guard)
      // Whatever teardown did, nothing of this app outlives the case.
      killProcessTree(child)
    }
  })
})

test.describe('E2E harness: main-process errors (17 §1.9)', () => {
  test('[ADR-002] an uncaught exception in the main process fails the teardown with its stack and never opens a modal error box', async () => {
    const current = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    const child = current.app.process()
    // The canary throws at quit only where the harness captures main-process errors, so a run
    // without the capture can never open Electron's modal "A JavaScript error occurred" box.
    // It throws inside the listener, not on a later tick: Electron reports a listener's exception
    // as uncaught before `app.quit()` returns, on every OS, while on macOS the whole quit can run
    // inside `app.quit()` and the process exit before a deferred throw (runs 37279955715 and
    // 37285520952: before-quit, destroyed, will-quit and exit 0 within 20 ms, nothing captured).
    await current.app.evaluate(({ app: electronApp }) => {
      electronApp.once('before-quit', () => {
        const captured = (globalThis as { __dwarfaiE2eMainErrors?: string }).__dwarfaiE2eMainErrors
        if (captured === undefined) return
        throw new Error('canary: thrown in the main process at quit')
      })
    })

    let guard: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        current.teardown().then(
          () => 'teardown resolved',
          (error: unknown) => (error as Error).message
        ),
        new Promise<string>((resolve) => {
          guard = setTimeout(() => resolve('teardown still running after 40 s'), 40_000)
        })
      ])

      expect(outcome).toMatch(/uncaught exception in the main process/)
      expect(outcome).toContain('canary: thrown in the main process at quit')
      expect(existsSync(current.profile.root), 'the temp profile is removed').toBe(false)
    } finally {
      clearTimeout(guard)
      killProcessTree(child)
    }
  })
})

/** The per-user folders a provider's data is found under (Antigravity `~/.gemini`, OpenCode `~/.local/share`, …). */
const HOME_VARIABLES = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME'
] as const

/** Whether `inner` is `outer` or a path under it. */
function isWithin(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

test.describe('E2E harness: the home folder of every launched app is the profile (17 §1.9; ADR-008 item 2)', () => {
  const profiles: { root: string; dataRoot: string }[] = []

  test.afterEach(() => {
    for (const profile of profiles.splice(0)) {
      rmSync(profile.root, { recursive: true, force: true })
      rmSync(profile.dataRoot, { recursive: true, force: true })
    }
  })

  test("[ADR-008] by default the app's HOME, USERPROFILE, APPDATA and XDG config and state homes are inside the profile, never the developer's own", () => {
    const profile = createIsolatedProfile()
    profiles.push(profile)

    const env = appEnv(profile, {})

    for (const name of HOME_VARIABLES) {
      const value = env[name]
      expect(value, `${name} is set for the app`).toBeDefined()
      expect(
        isWithin(value ?? '', profile.root) || isWithin(value ?? '', profile.dataRoot),
        `${name} (${value}) is inside the profile`
      ).toBe(true)
      if (process.env[name] !== undefined) {
        expect(value, `${name} is not the developer's own`).not.toBe(process.env[name])
      }
    }
    // macOS: HOME is the profile's short data root, so the Host's socket path under it fits sun_path (FM-037).
    if (process.platform === 'darwin') expect(env.HOME).toBe(profile.dataRoot)
  })

  test("[ADR-008] a case's own env still overrides a home variable explicitly", () => {
    const profile = createIsolatedProfile()
    profiles.push(profile)
    const chosen = path.join(profile.root, 'chosen-home')

    const env = appEnv(profile, { env: { HOME: chosen } })

    expect(env.HOME).toBe(chosen)
    expect(
      isWithin(env.USERPROFILE ?? '', profile.root) ||
        isWithin(env.USERPROFILE ?? '', profile.dataRoot)
    ).toBe(true)
  })

  test("[ADR-008] the launched app's main process sees its home folder inside the profile", async () => {
    const launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    try {
      const seen = await launched.app.evaluate((_electron, names) => {
        const values: Record<string, string | undefined> = {}
        for (const name of names) values[name] = process.env[name]
        return { homedir: process.getBuiltinModule('node:os').homedir(), values }
      }, HOME_VARIABLES)
      const { root, dataRoot } = launched.profile
      const inProfile = (value: string): boolean =>
        isWithin(realpathSync(value), realpathSync(root)) ||
        isWithin(realpathSync(value), realpathSync(dataRoot))

      expect(inProfile(seen.homedir), `the app's home folder (${seen.homedir})`).toBe(true)
      for (const name of HOME_VARIABLES) {
        const value = seen.values[name]
        expect(value, `${name} is set in the app`).toBeDefined()
        // The XDG folders need not exist yet: their parent, the profile's home, does.
        const existing = existsSync(value ?? '') ? (value ?? '') : seen.homedir
        expect(inProfile(existing), `${name} (${value}) is inside the profile`).toBe(true)
      }
    } finally {
      await launched.teardown()
    }
  })
})
