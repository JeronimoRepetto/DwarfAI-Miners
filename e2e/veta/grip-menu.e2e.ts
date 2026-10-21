import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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
 * L9 (ISSUE-290, moved from ISSUE-288 by review R8B-03; 07 machines 22 and 24; UC-046, UC-066; US-VETA-003.AC01,
 * US-LAUNCH-007.AC11; 17 §1.9): in the E2E build profile, whose built-modes list contains Veta, a click on the grip
 * and Enter on the focused grip open the same grip menu. "New dwarf in…" opens the mine picker; a search narrows it to
 * a mine nobody works in yet, and picking it closes the picker and rises the Add panel above the strip, aimed at that
 * mine, over a window grown for it first.
 */

test.describe.configure({ timeout: 300_000 })

/** The grip menu's items, in order. */
const menuItems = (veta: Page): Promise<string[]> =>
  veta.evaluate(
    `[...document.querySelectorAll('[data-veta-grip-menu] [role="menuitem"]')].map((item) => item.textContent.trim())`
  ) as Promise<string[]>

test.describe('New dwarf in… from the Veta grip (ISSUE-290)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-003.AC01, US-LAUNCH-007.AC11] from the grip a person opens New dwarf in…, searches a mine and picks it, and the Add panel rises aimed at it', async () => {
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

    // One mine at work, so the strip has its grip; a second one nobody works in yet.
    const ids: string[] = []
    for (const name of ['moria', 'erebor']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      ids.push(await declareMine(app, window, folder))
    }
    const [moria, erebor] = ids as [string, string]
    await launchClaude(window, moria)

    const veta = await showVeta(app, window)
    const grip = veta.locator('[data-veta-grip]')
    await expect(veta.locator('[data-veta-chamber]')).toHaveCount(1, { timeout: 60_000 })

    // A click on the grip, and Enter on the focused grip, open the same menu.
    await grip.click()
    await expect(veta.locator('[data-veta-grip-menu]')).toBeVisible({ timeout: 15_000 })
    const clicked = await menuItems(veta)
    // "New dwarf in…" carries its hint ▸.
    expect(clicked).toContain('New dwarf in…▸')
    await veta.keyboard.press('Escape')
    await expect(veta.locator('[data-veta-grip-menu]')).toHaveCount(0)
    await grip.focus()
    await grip.press('Enter')
    await expect(veta.locator('[data-veta-grip-menu]')).toBeVisible({ timeout: 15_000 })
    expect(await menuItems(veta)).toEqual(clicked)

    // New dwarf in…: the picker, searched down to the mine nobody works in.
    await veta
      .locator('[data-veta-grip-menu] [role="menuitem"]', { hasText: 'New dwarf in…' })
      .click()
    const search = veta.locator('[data-mine-picker] input')
    await expect(search).toBeFocused({ timeout: 15_000 })
    await search.pressSequentially('ere')
    const row = veta.locator(`[data-mine-picker] [data-mine="${erebor}"]`)
    await expect(row).toBeVisible()
    await expect(veta.locator(`[data-mine-picker] [data-mine="${moria}"]`)).toHaveCount(0)
    const before = await vetaBounds(app)

    // Picked: the picker closes and the Add panel rises aimed at that mine, over a window grown for it.
    await row.click()
    await expect(veta.locator('[data-mine-picker]')).toHaveCount(0)
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('add')
    await expect(veta.locator('[data-veta-root]')).toHaveAttribute('data-add-panel-for', erebor)
    await expect(veta.locator('[data-veta-risen] .dm-add')).toHaveAttribute(
      'aria-label',
      'Add a dwarf to erebor'
    )
    const grown = await vetaBounds(app)
    expect(grown.height).toBeGreaterThan(300)
    expect(grown.x + grown.width).toBe(before.x + before.width)
    expect(grown.y + grown.height).toBe(before.y + before.height)
  })
})
