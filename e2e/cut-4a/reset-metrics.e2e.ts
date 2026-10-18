import path from 'node:path'
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
import { STUB_BIN } from '../_harness/stubs.ts'

/**
 * L9, step 4a (ISSUE-235, moved from ISSUE-233, review R8B-03; ADR-023; 21 §3 `ResetFanout` ends): from the step-4a
 * switch A-33 runs the Host's Reset saga alone (`preferences.resetMetrics`). Settings › Data › "Reset metrics…" opens
 * the typed confirmation; "yes" typed and confirmed resets everything the ADR-023 scope names (here a Host-owned
 * preference written before, back to its default), and the dialog closes only once the Host answered `reset`.
 *
 * Not here: the Host killed during saga step 4 (13 CH-01) needs a fault point inside the saga that the L9 harness does
 * not have; the resume at the next start (US-SET-010.AC07) is proven by the L2 "Reset resume" suite
 * (`src/host/wiring/flows/resetResume.test.ts`), linked in docs/strangler/parity-cut-4a.md.
 */

test.describe.configure({ timeout: 180_000 })

interface RendererApi {
  api: {
    setNotificationsEnabled(on: boolean): Promise<unknown>
    getNotificationsEnabled(): Promise<unknown>
  }
}

test.describe('step 4a: Reset metrics through the Host saga (ISSUE-235)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SET-010.AC05] typing yes resets everything through the Host saga, and the dialog closes only after it succeeded', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const { window } = launched
    await answerFirstRunStep(window)

    // A Host-owned preference changed before the reset (A-43, routed host in 4a).
    const notifications = () =>
      window.evaluate(() => (globalThis as unknown as RendererApi).api.getNotificationsEnabled())
    await window.evaluate(() =>
      (globalThis as unknown as RendererApi).api.setNotificationsEnabled(false)
    )
    expect(await notifications()).toBe(false)

    await window.locator('.dm-nav .dm-slot[data-label="Settings"]').click()
    await window.locator('[role="tab"][data-s="Data"]').click()
    await window.locator('.reset-metrics').click()
    const dialog = window.locator('.dm-scrim [role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    const confirm = dialog.locator('.dm-dialog__actions button').nth(1)
    await expect(confirm).toBeDisabled()
    await dialog.locator('input').fill('yes')
    await expect(confirm).toBeEnabled()
    await confirm.click()

    // The dialog closes once the Host answered `reset`; the preference is back to its default (ADR-023 scope).
    await expect(dialog, 'a reset that went through closes its dialog').toBeHidden({
      timeout: 60_000
    })
    await expect.poll(notifications, { timeout: 30_000 }).toBe(true)
  })
})
