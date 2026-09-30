import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './launchApp.ts'

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
})
