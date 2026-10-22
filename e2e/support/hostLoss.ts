import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { isProcessAlive, profileHostPid, type IsolatedProfile } from '../_harness/launchApp.ts'

/*
 * The Host lost while a mode window is shown (ISSUE-296; 13 CH-01, CH-02; 17 §1.10): the real kill injector and what a
 * case reads back. The page's own scripts are strings: the e2e project has no DOM types.
 */

/**
 * Kills the profile's running Host (CH-01) and, unless `last`, waits until UI main started the next one. SIGKILL, so the
 * Host dies as in a crash on every OS: on Linux and macOS a SIGTERM is an OS session end, which the Host answers with
 * its clean exit, and UI main rightly starts nothing after it. On Windows both signals terminate the process.
 */
export async function killHost(profile: IsolatedProfile, last = false): Promise<void> {
  const pid = profileHostPid(profile.userDataDir)
  if (pid === null) throw new Error('no Host runs for the profile')
  process.kill(pid, 'SIGKILL')
  await expect.poll(() => isProcessAlive(pid), { timeout: 15_000 }).toBe(false)
  if (last) return
  await expect
    .poll(
      () => {
        const next = profileHostPid(profile.userDataDir)
        return next !== null && next !== pid && isProcessAlive(next)
      },
      { timeout: 60_000, message: 'UI main starts the Host again after a crash' }
    )
    .toBe(true)
}

/** The Host connection as a window reads it (A-N03). */
export async function hostConnectionOf(page: Page): Promise<{ state: string; reason?: string }> {
  return (await page.evaluate('window.api.getHostConnection()')) as {
    state: string
    reason?: string
  }
}

/** The `mode` query of every mode window on screen: the mode shown, and nothing else. */
export async function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.isVisible())
      .map((w) => new URL(w.webContents.getURL()).searchParams.get('mode') ?? 'panel')
  )
}
