import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  anyWindowVisible,
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
import { createClaudeStreamWorld, launchClaude, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { declareMine, risenContent, showVeta, vetaBounds } from '../support/veta.ts'

/**
 * L9 (ISSUE-290; 07 machine 24; UC-048; US-VETA-005.AC02, AC03; 17 §1.9): in the E2E build profile, whose built-modes
 * list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a mine with a stub Claude dwarf at work shows
 * its chamber. A click on the dwarf raises its chat above the strip, the Panel's own MessagePanel, over a window grown
 * for it first; a half-written message typed there is kept when Esc folds the chat, the window shrinking back once it
 * has gone, and it is there again on the next rise.
 */

test.describe.configure({ timeout: 300_000 })

test.describe("a dwarf's chat risen in Veta (ISSUE-290)", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[US-VETA-005.AC02, US-VETA-005.AC03] a person opens a dwarf's chat in Veta, types a draft, folds it and finds the draft again on the next rise", async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    const { dwarfId } = await launchClaude(window, mineId)

    const veta = await showVeta(app, window)
    const dwarf = veta.locator(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    // Hovering it shows its one-line label and opens nothing; the window holds the label's room from then on.
    await dwarf.hover()
    await expect(veta.locator('[data-veta-dwarf-label].is-on')).toBeVisible({ timeout: 15_000 })
    expect(await risenContent(veta)).toBe('none')
    const before = await vetaBounds(app)

    // A click on the dwarf: the window grows first, then the chat rises, anchored above the strip.
    await dwarf.click()
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    const grown = await vetaBounds(app)
    expect(grown.height).toBeGreaterThan(before.height + 300)
    // The island's anchor corner never moved: bottom edge, anchored at its end.
    expect(grown.x + grown.width).toBe(before.x + before.width)
    expect(grown.y + grown.height).toBe(before.y + before.height)
    const composer = veta.locator('[data-veta-risen] .dm-msg textarea')
    await expect(composer).toBeFocused()
    await composer.pressSequentially('half a thought')

    // Esc folds it: the chat goes, then the window gives the room back.
    await veta.keyboard.press('Escape')
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('none')
    await expect
      .poll(async () => (await vetaBounds(app)).height, { timeout: 15_000 })
      .toBe(before.height)
    await expect(veta.locator('[data-veta-risen]')).toHaveCount(0)

    // The next rise gives the draft back.
    await dwarf.click()
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    await expect(composer).toHaveValue('half a thought')
  })
})
