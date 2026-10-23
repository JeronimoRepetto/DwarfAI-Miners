import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
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
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/vetaScene.ts'

/**
 * L9 (ISSUE-304; US-VALLE-006.AC01, .AC02, .AC03, US-VALLE-009.AC01, .AC03; 07 machines 31, 32, S28.19; UC-058): in the E2E
 * build profile (Valle in its built-modes list, docs/e2e.md), the Control room's dashed "Add a mine here" slot adds a
 * mine not shown and a new project through the ordinary folder flow, a column's "⋯" swaps what its zone shows, and
 * "Close this column" takes it out with its toast; UI main stores each change at once (TC-304-01). A zone shows the
 * Panel's own Map and history, and the nav's Mines and Settings pages are the Panel's own, Settings without the rows
 * that act on the Panel window. The OS folder picker
 * is answered in the main process, as the other Add a mine cases do, so no dialog ever shows.
 */

test.describe.configure({ timeout: 300_000 })

/** UI main's Valle store files (`JsonUiPreferenceStore`, ISSUE-299). */
const LAYOUT_FILE = 'valle-layout-v1.json'
const ORDER_FILE = 'valle-mosaic-order-v1.json'

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The next OS folder picker opened by UI main answers `folder` (no dialog shows). */
async function answerFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    ;(dialog as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [picked] })
  }, folder)
}

test.describe('Valle zones and the mosaic (ISSUE-304)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-006.AC02, US-VALLE-006.AC03, US-VALLE-009.AC01, US-VALLE-009.AC03] a person adds a mine and a new project from the add slot, swaps a zone to its history and closes a column', async () => {
    profile = createIsolatedProfile()
    const prefs = profile.userDataDir
    launched = await launchApp({
      profile,
      trayProbe: true,
      tracePath: test.info().outputPath(`trace-${Date.now()}.zip`)
    })
    await waitForHostAttached(profile)
    const { app, window } = launched
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    const folders = ['first-mine', 'second-mine', 'third-mine'].map((name) =>
      path.join(profile!.root, name)
    )
    for (const folder of folders) mkdirSync(folder)
    const firstMine = await declareMine(app, window, folders[0]!)
    await declareMine(app, window, folders[1]!)

    const valle = await showValle(app, window)
    await valleSettled(valle)
    // A first visit: no mine has a crew, so the first mosaic is empty (07 S32.01).
    // AMENDED for owner ruling 2026-10-23 (VQA-07) (was: the empty order written as such): the person has not arranged
    // the order, so it is computed live and nothing is written; the first pick below is what arranges and writes it.
    await expect(valle.locator('[data-valle-column]')).toHaveCount(0)
    expect(readJson(path.join(prefs, ORDER_FILE))).toBeNull()

    // The add slot lists the mines not shown, then "A new project…"; a picked mine joins the end (S32.04, S32.05).
    const slot = valle.locator('[data-valle-add]')
    await expect(slot).toContainText('Add a mine here')
    await slot.click()
    const slotMenu = valle.locator('[data-valle-add-menu]')
    await expect(slotMenu.getByRole('menuitem', { name: /^second-mine/ })).toBeVisible()
    await expect(slotMenu.getByRole('menuitem', { name: 'A new project…' })).toBeVisible()
    await slotMenu.getByRole('menuitem', { name: /^first-mine/ }).click()
    const column = valle.locator(`[data-valle-column="${firstMine}"]`)
    await expect(column).toBeVisible()
    await expect
      .poll(() => readJson(path.join(prefs, ORDER_FILE)), { timeout: 10_000 })
      .toEqual({ order: [firstMine] })

    // "A new project…": the ordinary folder flow, answered in main; the new mine joins, no Add panel (S32.08…S32.11).
    await answerFolderPicker(app, folders[2]!)
    await slot.click()
    await slotMenu.getByRole('menuitem', { name: 'A new project…' }).click()
    await expect(valle.locator('[data-valle-column]')).toHaveCount(2, { timeout: 30_000 })
    const third = valle.locator('[data-valle-column]').nth(1)
    await expect(third).toHaveAttribute('aria-label', 'Mine third-mine')
    const thirdMine = (await third.getAttribute('data-valle-column'))!
    await expect
      .poll(() => readJson(path.join(prefs, ORDER_FILE)), { timeout: 10_000 })
      .toEqual({ order: [firstMine, thirdMine] })

    // "⋯" › "Show here: the map": the Panel's own Map page is drawn in the zone, in its slot (S31.03).
    await column.locator('[data-zone-more]').click()
    await valle.getByRole('menuitem', { name: /^Show here: the map/ }).click()
    await expect(column).toHaveAttribute('data-content', 'map')
    await expect(column.locator('[data-zone-content="map"] .dm-mappage')).toBeVisible()
    await expect(column.locator('[data-zone-suffix]')).toHaveText('· Map')

    // The nav's Mines page over the main zone draws the Panel's Mines list (S28.19); Esc returns to the mosaic.
    await valle.locator('[data-slot="mines"]').click()
    await expect(valle.locator('[data-valle-page="mines"] .dm-mines')).toBeVisible()
    await expect(valle.getByRole('button', { name: /^Open second-mine/ })).toBeVisible()
    await valle.keyboard.press('Escape')
    await expect(valle.locator('[data-valle-page]')).toHaveCount(0)

    // The nav's Settings page: the Panel's own, without the rows that act on the Panel window (owner decision
    // 2026-10-22).
    await valle.locator('[data-slot="settings"]').click()
    const settings = valle.locator('[data-valle-page="settings"] .dm-settings')
    await expect(settings).toBeVisible()
    await expect(settings).toContainText('Panel shortcut')
    await expect(settings.locator('.position-right')).toHaveCount(0)
    await expect(settings.locator('.pin')).toHaveCount(0)
    await valle.keyboard.press('Escape')
    await expect(valle.locator('[data-valle-page]')).toHaveCount(0)

    // "⋯" › "Show here: history": the zone swaps in its slot, the header notes it, the layout is stored (S31.05).
    await column.locator('[data-zone-more]').click()
    await valle.getByRole('menuitem', { name: /^Show here: history/ }).click()
    await expect(column).toHaveAttribute('data-content', 'history')
    await expect(column.locator('[data-zone-suffix]')).toHaveText('· History')
    await expect(column.locator('[data-zone-content="history"] .dm-hist')).toBeVisible()
    await expect(valle.locator('[data-valle-column]').first()).toHaveAttribute(
      'data-valle-column',
      firstMine
    )
    await expect
      .poll(() => readJson(path.join(prefs, LAYOUT_FILE)), { timeout: 10_000 })
      .toMatchObject({ control: { zones: { [firstMine]: { content: 'history' } } } })

    // "Close this column": the column leaves with its toast, the order stored without it (S32.03).
    await column.locator('[data-zone-more]').click()
    await valle.getByRole('menuitem', { name: 'Close this column' }).click()
    await expect(valle.locator('.dm-toasts')).toContainText(
      'first-mine left the Control room · its dwarfs keep working'
    )
    await expect(column).toHaveCount(0)
    await expect
      .poll(() => readJson(path.join(prefs, ORDER_FILE)), { timeout: 10_000 })
      .toEqual({ order: [thirdMine] })
  })
})
