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

/**
 * L9, cut 0 (moved from ISSUE-317, review R8B-02; TC-056-06): the rebuilt tray's Stop everything and quit asks for its
 * confirmation in the window (A-N25 pushed by UI main, shown by the renderer's StopEverythingConfirmation), and Cancel
 * (A-N27) closes it with nothing stopped. The tray is chosen through the tray probe, the item's own click.
 */

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: the Stop everything confirmation in the window (ISSUE-317)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    // Ends the case's Host the way a person does, and fails when anything is left running.
    await launched?.teardown({ stopEverything: true })
    launched = undefined
  })

  test("[US-RES-002.AC08, US-RES-002.AC10] the tray's Stop everything opens the confirmation in the window and cancelling leaves the app and the tray icon as they were", async () => {
    launched = await launchApp({
      trayProbe: true,
      env: homeIn,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window, profile } = launched
    const hostPid = await waitForHostAttached(profile)
    expect(trayEvents(profile), 'the tray icon shows').toEqual(['shown'])
    expect(await anyWindowVisible(app), 'the app starts in the tray').toBe(false)

    await chooseTrayItem(app, TRAY_ITEMS.stopEverything)
    const confirmation = window.getByRole('dialog')
    await expect(confirmation).toBeVisible({ timeout: 30_000 })
    expect(await anyWindowVisible(app), 'the confirmation opened the window').toBe(true)

    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmation).toBeHidden()
    // As they were: the app, its Host and the icon all still run, nothing was stopped.
    expect(app.process().exitCode).toBeNull()
    expect(isProcessAlive(hostPid), 'the Host keeps running').toBe(true)
    expect(trayEvents(profile), 'the icon stays').toEqual(['shown'])
  })
})
