import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  disposeProfile,
  isProcessAlive,
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

  // ADDED for ISSUE-141 (lead decision 2026-10-14): Stop everything and quit is the one person-facing way to stop the
  // Host (ADR-002 D7, OQ-63), and the step has no way out of its own (US-SET-012.AC06), so the confirmation opens above
  // the step, and quitting before an answer leaves the step due for the next window (07 S41.08).
  test('[US-RES-002.AC08, US-RES-002.AC09] Stop everything and quit is reachable while the first-run step is open: its confirmation is on top and Confirm ends the app and its Host', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const before = claudeSettings(owned)
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    // Held now: once the app exited, Playwright no longer hands its process out.
    const child = app.process()
    const hostPid = await waitForHostAttached(owned)
    const step = welcomeStep(window)
    await expect(step.options, 'the first-run step is shown').toBeVisible({ timeout: 60_000 })

    await window.evaluate(() => {
      ;(window as unknown as { api: { requestStopEverything(): void } }).api.requestStopEverything()
    })
    // The step beneath is inert, so the confirmation is the one dialog a person (and the accessibility tree) reaches.
    const confirmation = window.getByRole('dialog')
    await expect(confirmation).toHaveCount(1, { timeout: 30_000 })
    await expect(confirmation.getByRole('button', { name: /and quit$/ })).toBeVisible()
    await expect(step.options, 'the step stays open beneath').toBeAttached()
    await confirmation.getByRole('button', { name: /and quit$/ }).click({ timeout: 10_000 })

    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, {
        timeout: 60_000,
        message: 'the app quits'
      })
      .toBe(true)
    await expect
      .poll(() => isProcessAlive(hostPid), { timeout: 60_000, message: 'the Host stops' })
      .toBe(false)
    launched = undefined
    // Nothing was answered, so nothing was written (07 S41.08).
    expect(claudeSettings(owned)).toBe(before)
  })
})
