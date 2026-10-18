import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  homeIn,
  launchApp,
  trayEvents,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'

/**
 * L9, the shell start (21 §2 cut 5 preparation for ISSUE-243): the start work today's composition did and nothing else
 * does, now UI main's (src/ui-main/window/application/shellStart.ts), on the built app. On macOS the app owns no Dock
 * tile once it started. On every OS the login entry is what it was before the start: the harness launches an unpackaged
 * build, which never writes one (the candidate login entry is composed for a packaged build only), so the entry the
 * machine holds (the Windows Run values, the LaunchAgent or XDG file in the profile's home) is unchanged.
 */

test.describe.configure({ timeout: 180_000 })

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** One Run value's data, or null when the value is absent (`reg query` fails for a missing value). */
function runValue(name: string): string | null {
  try {
    return execFileSync('reg', ['query', RUN_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/** The login entry as this OS holds it for the app: the Run values, or the LaunchAgent / XDG file in the home. */
function loginEntryState(home: string): Record<string, string | null> {
  if (process.platform === 'win32') {
    return { 'DwarfAI-Miners': runValue('DwarfAI-Miners'), AgentName: runValue('AgentName') }
  }
  const file =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', 'com.jeronimorepetto.dwarfaiminers.plist')
      : path.join(home, '.config', 'autostart', 'dwarfai-miners.desktop')
  return { [file]: existsSync(file) ? readFileSync(file, 'utf8') : null }
}

/** The home `homeIn` gives the app (the profile's short data root on macOS, `<root>/home` elsewhere). */
function homeOf(profile: IsolatedProfile): string {
  return process.platform === 'darwin' ? profile.dataRoot : path.join(profile.root, 'home')
}

test.describe('the shell start (21 §2 cut 5)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
  })

  test('[ADR-001] the started app owns no Dock tile on macOS and leaves the login entry as it found it', async () => {
    let before: Record<string, string | null> = {}
    launched = await launchApp({
      trayProbe: true,
      env: homeIn,
      beforeLaunch: async (profile) => {
        before = loginEntryState(homeOf(profile))
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, profile } = launched
    await waitForHostAttached(profile)
    // The tray starts right before the shell start, which runs right before today's runtime is composed.
    await expect.poll(() => trayEvents(profile)).toEqual(['shown'])

    if (process.platform === 'darwin') {
      await expect
        .poll(() => app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible() ?? null))
        .toBe(false)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(loginEntryState(homeOf(profile))).toEqual(before)
  })
})
