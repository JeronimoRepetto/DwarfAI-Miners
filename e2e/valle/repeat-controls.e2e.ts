import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
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
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (07 machine 28; US-VALLE-001, US-VALLE-002, US-VALLE-003): in the E2E build profile (Valle in its built-modes list,
 * docs/e2e.md), every control of Valle's top bar and nav column takes effect each time it is pressed, not only the
 * first: the preset tabs and their arrow keys, the dive's `⤢` and the climb out, and the nav column's pages. Two mines,
 * one with a stub Claude dwarf whose chat is pinned, so the dive and the climb carry real chats and portraits.
 */

test.describe.configure({ timeout: 300_000 })

/** The Valle root's preset, the nav page over the main zone (or its zones), and its motion, read in one go. */
function stateOf(valle: Page): Promise<string> {
  return valle.evaluate(
    "(() => { const r = document.querySelector('[data-valle-root]'); const p = document.querySelector('[data-valle-page]'); return [r.dataset.preset, p === null ? 'zones' : p.dataset.vallePage, r.dataset.motion].join(' ') })()"
  ) as Promise<string>
}

/** Presses `control` and waits until the root reads `expected` at rest. */
async function pressAndExpect(valle: Page, control: Locator, expected: string): Promise<void> {
  await control.click()
  await expect.poll(() => stateOf(valle), { timeout: 10_000 }).toBe(`${expected} none`)
}

test.describe("Valle's controls, pressed again and again", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-001.AC01, US-VALLE-001.AC02, US-VALLE-002.AC01, US-VALLE-003.AC01] the preset tabs, their arrow keys, the dive and the nav pages each take effect on every press', async () => {
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

    const mines: string[] = []
    for (const name of ['moria', 'erebor']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      mines.push(await declareMine(app, window, folder))
    }
    const dwarf = await launchClaude(window, mines[0]!)
    const written = (await window.evaluate(
      `window.api.setUiPreference(${JSON.stringify({
        key: 'pins',
        value: [{ dwarfId: dwarf.dwarfId, mineId: mines[0], order: 0 }]
      })})`
    )) as unknown
    expect(written, 'A-N21 takes the pin').toBeTruthy()

    const valle = await showValle(app, window)
    const errors: string[] = []
    valle.on('pageerror', (error) => errors.push(error.message))
    await valleSettled(valle)
    await expect(valle.locator('[data-valle-column]')).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(() => stateOf(valle)).toBe('control zones none')

    const front = valle.getByRole('tab', { name: 'Work front' })
    const control = valle.getByRole('tab', { name: 'Control room' })
    // The preset tabs, three round trips.
    for (let round = 0; round < 3; round++) {
      await pressAndExpect(valle, front, 'front zones')
      await pressAndExpect(valle, control, 'control zones')
    }
    // The arrow keys on a focused tab, three round trips.
    for (let round = 0; round < 3; round++) {
      await control.focus()
      await valle.keyboard.press('ArrowRight')
      await expect.poll(() => stateOf(valle), { timeout: 10_000 }).toBe('front zones none')
      await front.focus()
      await valle.keyboard.press('ArrowLeft')
      await expect.poll(() => stateOf(valle), { timeout: 10_000 }).toBe('control zones none')
    }
    // ⤢ on a column and the climb out, three times.
    for (let round = 0; round < 3; round++) {
      await pressAndExpect(
        valle,
        valle.locator(`[data-valle-column="${mines[0]}"] button.dm-vz__dive`),
        'front zones'
      )
      await pressAndExpect(valle, control, 'control zones')
    }
    // The nav column: Map, then Mines from the Map, Mines again back to the zones (S28.20), then Settings, then the Map
    // from Settings, each a press.
    const slot = (id: string): Locator => valle.locator(`nav.dm-valle__nav [data-slot="${id}"]`)
    for (let round = 0; round < 3; round++) {
      await pressAndExpect(valle, slot('map'), 'control map')
      await pressAndExpect(valle, slot('mines'), 'control mines')
      await pressAndExpect(valle, slot('mines'), 'control zones')
      await pressAndExpect(valle, slot('settings'), 'control settings')
      await pressAndExpect(valle, slot('map'), 'control map')
      await valle.keyboard.press('Escape')
      await expect.poll(() => stateOf(valle), { timeout: 10_000 }).toBe('control zones none')
    }
    // A preset tab on a page: the page gives way and the tab takes effect, every time.
    for (let round = 0; round < 3; round++) {
      // Map, then a tab.
      await pressAndExpect(valle, slot('map'), 'control map')
      await pressAndExpect(valle, front, 'front zones')
      // Map, Mines, Settings, then a tab.
      await pressAndExpect(valle, slot('map'), 'front map')
      await pressAndExpect(valle, slot('mines'), 'front mines')
      await pressAndExpect(valle, slot('settings'), 'front settings')
      await pressAndExpect(valle, control, 'control zones')
      // Map, Esc, Map again, then a tab.
      await pressAndExpect(valle, slot('map'), 'control map')
      await valle.keyboard.press('Escape')
      await expect.poll(() => stateOf(valle), { timeout: 10_000 }).toBe('control zones none')
      await pressAndExpect(valle, slot('map'), 'control map')
      await pressAndExpect(valle, control, 'control zones')
    }
    expect(errors).toEqual([])
  })
})
