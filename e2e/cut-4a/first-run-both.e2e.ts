import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { withStubs, type StubSetup } from '../_harness/stubs.ts'
import {
  claudeSettings,
  expectStepShown,
  hookCommands,
  isHostEntry,
  welcomeStep
} from '../cut-2/claudeHooksWorld.ts'
import { integrationState, openCodePlugin, openCodeSettings } from './openCodeWorld.ts'

/**
 * L9, step 4a (ISSUE-235, moved from ISSUE-232, review R8B-03; OQ-68; AMENDMENT-9, OQ-70; 07 machine 41): from the
 * step-4a switch the first-run consent step offers OpenCode too when it is installed (21 §2 cut 4a "New core serves":
 * `offered` gains `opencode-permissions`). On a clean profile with both stubs installed the step shows both options,
 * each pre-selected; one Activate is the consent for both, the Host writes its Claude hook entry and its OpenCode plugin
 * file, and Settings then reads both integrations on (US-SET-012.AC01, AC02). Nothing is written before the click
 * (ADR-016 item 5).
 */

test.describe.configure({ timeout: 180_000 })

test.describe('step 4a: the first-run step with Claude Code and OpenCode installed (ISSUE-235)', () => {
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

  test('[US-SET-012.AC01, US-SET-012.AC02] a clean profile with both stubs installed shows both options ticked, and Activate leaves both Settings toggles on', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    stubs = withStubs(['claude', 'opencode'])
    const before = claudeSettings(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubs.stubs,
      env: stubs.env,
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const { window } = launched
    const step = welcomeStep(window)

    // Both options shown, both on (07 S41.01; OQ-68: each installed tool pre-selected), nothing written yet.
    await expectStepShown(window, { launched, profile: owned })
    await expect(step.toggles).toHaveCount(2)
    await expect(step.toggles.nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(step.toggles.nth(1)).toHaveAttribute('aria-checked', 'true')
    expect(claudeSettings(owned)).toBe(before)
    expect(openCodePlugin(owned), 'no plugin file before the click (OQ-17, R-09)').toBeNull()

    await step.activate.click()
    await expect(step.dialog, 'the answered step closes').toBeHidden({ timeout: 30_000 })

    // The Host wrote both entries, and Settings reads both integrations on (A-52; the `preferences` section).
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000,
        message: 'the Host writes its own Claude hook entry'
      })
      .toBeGreaterThan(0)
    await expect
      .poll(() => openCodePlugin(owned) !== null, {
        timeout: 30_000,
        message: 'the Host writes its OpenCode plugin file'
      })
      .toBe(true)
    const settings = await openCodeSettings(window)
    expect(settings.ok, 'A-52 is routed host in 4a').toBe(true)
    expect(settings.value?.permissions).not.toBe('off')
    expect(settings.value?.consentOrigin).toBe('first-run')
    expect(await integrationState(window, 'claude-hooks')).not.toBe('off')
    expect(await integrationState(window, 'opencode-permissions')).not.toBe('off')
  })
})
