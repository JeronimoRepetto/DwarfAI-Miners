import { expect, test } from '@playwright/test'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { seedMine } from '../cut-3a/claudeStreamWorld.ts'
import { createOpenCodeWorld, openCodeOnlyPath } from '../cut-4b/openCodeAcpWorld.ts'
import { openCodePlugin, openCodeSettings } from './openCodeWorld.ts'

/**
 * L9, step 4a (ISSUE-235, moved from ISSUE-228, review R8B-03; ADR-011 item 7; ADR-016 items 1, 5; 16 §7.2): the Add
 * panel's OpenCode action turns the permission requests on as if from Settings, recorded with the consent origin
 * `add-panel` (C-21), through A-53, which the step-4a switch routes to the Host: the Host writes its plugin file (after
 * the backup the config writer takes of whatever was there, ADR-016 item 7) before any launch is sent, and Settings,
 * which follows the Host, shows the option on.
 *
 * The Add panel draws the notice and its "Turn on" action (owner-approved copy 2026-10-18) for an entry whose
 * `answerChannel` is `gated-off`. AMENDED for ISSUE-238 (was: the case sent exactly what the action sends from the
 * renderer's own `window.api`, because in 4a OpenCode's A-36 entry still came from today's catalog through
 * `CatalogMergeAdapter`, which read it `available`): from the step-4b switch OpenCode's entry is the Host's, which reads
 * the integration off as `gated-off`, so the case picks OpenCode in the Add panel and clicks the real "Turn on". The
 * installed OpenCode is the step-4b stub (`../cut-4b/openCodeAcpWorld.ts`), which the Host's driver probes and lists.
 */

test.describe.configure({ timeout: 180_000 })

test.describe('step 4a: OpenCode consent from the Add panel (ISSUE-235)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-LAUNCH-001.AC13, C-21] the Add-panel action writes the plugin file with a backup before any launch is sent, and Settings shows the option on', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createOpenCodeWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: openCodeOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const { app, window } = launched
    // The Panel is built hidden at start (the tray state): a person opens it from the tray, which fits it to the screen
    // (zoom, then bounds). Driving the never-shown window instead left its page unzoomed in a window sized for the
    // zoomed page, so on a screen whose UI scale is below 1 (the Windows runner) Settings drew its tabs off-screen.
    await chooseTrayItem(app, TRAY_ITEMS.open)
    // OpenCode is installed, so the first-run step is due (OQ-68): answered with nothing ticked, it writes nothing.
    expect(await answerFirstRunStep(window), 'the step offers OpenCode from 4a').toBe(true)
    expect(openCodePlugin(owned)).toBeNull()
    expect((await openCodeSettings(window)).value?.permissions).toBe('off')
    await seedMine(window, owned)

    // The Add panel of the mine, OpenCode chosen: its permission requests cannot be answered yet, so the notice shows.
    const nav = window.locator('nav.dm-nav')
    await nav.locator('.dm-slot[data-label="Map"]').click({ timeout: 30_000 })
    await window.locator('.dm-marker').first().click({ timeout: 60_000 })
    await window.locator('.dm-minecol__foot .dm-btn--primary').click({ timeout: 30_000 })
    await window.locator('.dm-add__chips [data-value="opencode"]').click({ timeout: 60_000 })
    const notice = window.locator('.dm-add__integration')
    await expect(notice, 'the OpenCode notice is drawn').toBeVisible({ timeout: 30_000 })

    // The real "Turn on": A-53 with the `add-panel` origin; no launch is sent before it settles.
    await notice.locator('.dm-add__integration-action').click()
    await expect
      .poll(() => openCodePlugin(owned), {
        timeout: 30_000,
        message: 'the plugin file is written when the answer comes'
      })
      .not.toBeNull()
    expect(world.runs(), 'no launch was sent').toEqual([])
    await expect(notice, 'the notice goes once the requests can be answered').toBeHidden({
      timeout: 30_000
    })

    // Settings follows the Host: the option is on, recorded as the Add panel's consent.
    const settings = await openCodeSettings(window)
    expect(settings.value?.permissions).not.toBe('off')
    expect(settings.value?.consentOrigin).toBe('add-panel')
    await window.keyboard.press('Escape')
    await nav.locator('.dm-slot[data-label="Settings"]').click()
    await window.locator('[role="tab"][data-s="Integrations"]').click()
    await expect(window.locator('.opencode-plugin-enabled')).toHaveAttribute(
      'aria-checked',
      'true',
      {
        timeout: 30_000
      }
    )
  })
})
