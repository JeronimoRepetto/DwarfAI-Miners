import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { withStubs, type StubSetup } from '../_harness/stubs.ts'
import { openCodePlugin, openCodeSettings, uuidV7 } from './openCodeWorld.ts'

/**
 * L9, step 4a (ISSUE-235, moved from ISSUE-228, review R8B-03; ADR-011 item 7; ADR-016 items 1, 5; 16 §7.2): the Add
 * panel's OpenCode action turns the permission requests on as if from Settings, recorded with the consent origin
 * `add-panel` (C-21), through A-53, which the step-4a switch routes to the Host: the Host writes its plugin file (after
 * the backup the config writer takes of whatever was there, ADR-016 item 7) before any launch is sent, and Settings,
 * which follows the Host, shows the option on.
 *
 * The Add panel draws the notice and its "Turn on" action (owner-approved copy 2026-10-18) for an entry whose
 * `answerChannel` is `gated-off`. In 4a OpenCode's A-36 entry still comes from today's catalog through
 * `CatalogMergeAdapter`, which reads it `available` (its launch rows stay `legacy` until 4b), so the panel offers no
 * notice for it yet (forward note for ISSUE-238). This case therefore sends exactly what the action sends, from the
 * renderer's own `window.api` (`useAgentLaunch.enableIntegration`): A-53 `{ on: true, origin: 'add-panel', requestId }`.
 */

test.describe.configure({ timeout: 180_000 })

test.describe('step 4a: OpenCode consent from the Add panel (ISSUE-235)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined
  let stubs: StubSetup | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
    stubs?.dispose()
    stubs = undefined
  })

  test('[US-LAUNCH-001.AC13, C-21] the Add-panel action writes the plugin file with a backup before any launch is sent, and Settings shows the option on', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    stubs = withStubs(['opencode'])
    launched = await launchApp({
      profile: owned,
      stubs: stubs.stubs,
      env: stubs.env,
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const { window } = launched
    // OpenCode is installed, so the first-run step is due (OQ-68): answered with nothing ticked, it writes nothing.
    expect(await answerFirstRunStep(window), 'the step offers OpenCode from 4a').toBe(true)
    expect(openCodePlugin(owned)).toBeNull()
    expect((await openCodeSettings(window)).value?.permissions).toBe('off')

    // The Add panel's action: A-53 with the `add-panel` origin; no launch is sent before it settles.
    const answer = (await window.evaluate(
      (requestId) =>
        (
          globalThis as unknown as {
            api: { setOpenCodePluginEnabled(request: unknown): Promise<unknown> }
          }
        ).api.setOpenCodePluginEnabled({ on: true, origin: 'add-panel', requestId }),
      uuidV7()
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(answer.ok, 'A-53 is routed host in 4a').toBe(true)
    expect(answer.value?.ok, 'the Host wrote and read back its plugin file').toBe(true)
    expect(openCodePlugin(owned), 'the plugin file is written when the answer comes').not.toBeNull()

    // Settings follows the Host: the option is on, recorded as the Add panel's consent.
    const settings = await openCodeSettings(window)
    expect(settings.value?.permissions).not.toBe('off')
    expect(settings.value?.consentOrigin).toBe('add-panel')
    await window.locator('.dm-nav .dm-slot[data-label="Settings"]').click()
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
