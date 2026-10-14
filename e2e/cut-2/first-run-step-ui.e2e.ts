import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  disposeProfile,
  launchApp,
  waitForHostAttached,
  createIsolatedProfile,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  claudeSettings,
  foreignLine,
  hookCommands,
  isHostEntry,
  seedForeignEntry,
  welcomeStep
} from './claudeHooksWorld.ts'

/**
 * L9, cut 2 (ISSUE-141, moved from ISSUE-224, review R8B-03; AMENDMENT-7, OQ-68; 07 machine 41): the first-run consent
 * step on a clean profile with the Claude stub installed. The step is the Panel's first sight, with the Claude Code
 * option on (pre-selected); one Activate is the consent, and the Host writes its own hook entry into the profile's
 * `CLAUDE_CONFIG_DIR` (ADR-016 items 1, 5), the person's own hook untouched. The step is never a trap: with the option
 * turned off, Activate closes it too, and nothing is written (US-SET-012.AC06, AC07; the cut-2 switch routes A-N32,
 * without which Activate had nowhere to go once the hook ingress persisted its port at the first boot).
 */

test.describe.configure({ timeout: 180_000 })

test.describe('cut 2: the first-run consent step (ISSUE-141)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SET-012.AC05, US-SET-012.AC07] a clean profile with the Claude stub installed shows the step with the Claude Code option ticked, and Activate writes the hook entry into a temp CLAUDE_CONFIG_DIR', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    seedForeignEntry(owned)
    const before = claudeSettings(owned)
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const step = welcomeStep(launched.window)

    // The step shows with the one offered option, Claude Code, on (07 S41.01; AMENDMENT-9: `offered` is
    // `['claude-hooks']` in cut 2), and nothing was written before the click (ADR-016 item 5).
    await expect(step.options, 'the first-run step is shown').toBeVisible({ timeout: 60_000 })
    await expect(step.toggles).toHaveCount(1)
    await expect(step.toggles.first()).toHaveAttribute('aria-checked', 'true')
    expect(claudeSettings(owned)).toBe(before)

    await step.activate.click()

    // The answer settles the step (its `preferences.changed` frame closes it), and the Host's entry is in the file.
    await expect(step.dialog, 'the step closes once answered').toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000,
        message: "the Host writes its own entry into the profile's settings.json"
      })
      .toBeGreaterThan(0)
    // The person's own hook keeps its bytes (ADR-016 item 6).
    expect(foreignLine(claudeSettings(owned))).toBe(foreignLine(before))
  })

  test('[US-SET-012.AC06, ADR-016] the step is never a trap: with the option turned off, Activate closes it and writes nothing', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    seedForeignEntry(owned)
    const before = claudeSettings(owned)
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const step = welcomeStep(launched.window)
    await expect(step.options).toBeVisible({ timeout: 60_000 })

    await step.toggles.first().click()
    await expect(step.toggles.first()).toHaveAttribute('aria-checked', 'false')
    await step.activate.click()

    await expect(step.dialog, 'Activate is the way out, whatever the ticks').toBeHidden({
      timeout: 30_000
    })
    // Both unticked: nothing written (07 S41.06).
    expect(claudeSettings(owned)).toBe(before)
  })
})
