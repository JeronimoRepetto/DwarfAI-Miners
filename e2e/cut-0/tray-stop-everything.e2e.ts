import { expect, test } from '@playwright/test'
import {
  anyWindowVisible,
  chooseTrayItem,
  homeIn,
  isProcessAlive,
  launchApp,
  TRAY_ITEMS,
  trayEvents,
  waitForHostAttached,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { seedLegacyFixtureSession, type LegacyFixtureSession } from './legacyFixtureSession.ts'
import { exitsWithin } from './stopAllWorld.ts'

/**
 * L9, cut 0 (moved from ISSUE-053, review R8B-02; TC-056-06; ADR-002 D7; ADR-018 item 5): the rebuilt tray of the
 * app's entry. Quit closes the windows and ends nothing; Stop everything and quit, confirmed in the window, ends the
 * sessions, the Host and the app, and the icon goes. The harness teardown through it leaves no test Host running
 * (review R7V-01). The tray is chosen through the tray probe, the item's own click; the fixture session is a stub
 * process today's runtime launched (`legacyFixtureSession.ts`).
 */

test.describe.configure({ timeout: 180_000 })

/** The confirm button of the window's confirmation (ISSUE-317; the design's copy marker). */
const CONFIRM = /confirm button naming the count/

test.describe('cut 0: Quit and Stop everything and quit from the tray (ISSUE-053)', () => {
  let launched: LaunchedApp | undefined
  let session: LegacyFixtureSession | undefined

  test.afterEach(async () => {
    session?.dispose()
    session = undefined
    await launched?.teardown()
    launched = undefined
  })

  test('[ADR-002] Quit from the tray leaves the icon and a fixture session running; Stop everything and quit with none failing removes the icon', async () => {
    launched = await launchApp({
      trayProbe: true,
      env: homeIn,
      beforeLaunch: async (profile) => {
        session = await seedLegacyFixtureSession(profile)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window, profile } = launched
    const hostPid = await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await expect.poll(() => anyWindowVisible(app)).toBe(true)

    // Quit: every window closes; the app, the icon, the Host and the session stay (S10.15; INV-122).
    await chooseTrayItem(app, TRAY_ITEMS.quit)
    await expect.poll(() => anyWindowVisible(app)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(app.process().exitCode, 'the app keeps running').toBeNull()
    expect(trayEvents(profile), 'the icon stays').toEqual(['shown'])
    expect(session?.alive(), 'the fixture session keeps running').toBe(true)
    expect(isProcessAlive(hostPid), 'the Host keeps running').toBe(true)

    // Stop everything and quit, confirmed in the window it opens: nothing fails, so the app exits with its Host and
    // the icon goes (S10.20; ADR-002 D7 step 4).
    await chooseTrayItem(app, TRAY_ITEMS.stopEverything)
    await window.getByRole('button', { name: CONFIRM }).click({ timeout: 30_000 })
    expect(await exitsWithin(app.process(), 30_000), 'the app exits').toBe(true)
    expect(trayEvents(profile), 'the icon is removed').toEqual(['shown', 'removed'])
    expect(session?.alive(), 'the fixture session was ended').toBe(false)
    await expect.poll(() => isProcessAlive(hostPid), { timeout: 15_000 }).toBe(false)
  })

  test('[ADR-002] the harness teardown through Stop everything and quit leaves no test Host process running', async () => {
    const current = await launchApp({
      trayProbe: true,
      env: homeIn,
      tracePath: test.info().outputPath('trace.zip')
    })
    launched = current
    const hostPid = await waitForHostAttached(current.profile)
    const appProcess = current.app.process()

    await current.teardown({ stopEverything: true })

    expect(isProcessAlive(hostPid), 'no test Host is left running').toBe(false)
    expect(appProcess.exitCode, 'the app exited').not.toBeNull()
  })
})
