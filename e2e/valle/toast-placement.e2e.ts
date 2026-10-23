import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
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
import { muteAppAudio, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (VQA-12; US-VALLE-010.AC05; BR-23; ISSUE-309 DR-05; 07 §24 I-38): with a mine's column in the Control room and a
 * dwarf's chat pinned and open beside it, "Reset preset" raises its toast, and the toast covers none of the mine columns,
 * the chat zone or a composer: it stands on Valle's widest free area. With `DWARFAI_E2E_SHOTS` set, the window is saved
 * with the toast shown.
 *
 * Every page is muted first. The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 300_000 })

type Box = { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  expect(box, 'laid out').not.toBeNull()
  return box!
}

const apart = (a: Box, b: Box): boolean =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

/** Every box `selector` matches in `page`. */
async function boxesOf(page: Page, selector: string): Promise<Box[]> {
  const boxes: Box[] = []
  for (const item of await page.locator(selector).all()) {
    const box = await item.boundingBox()
    if (box !== null) boxes.push(box)
  }
  return boxes
}

/** The page whose URL holds `mode=valle`, once Playwright lists it. */
async function vallePage(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes('mode=valle'))
        return page !== undefined
      },
      { timeout: 15_000, message: 'Playwright lists the Valle page' }
    )
    .toBe(true)
  return page!
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['DWARFAI_E2E_SHOTS']
  if (dir === undefined || dir === '') return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test.describe("Valle's toast placement (VQA-12)", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-010.AC05] the "Reset preset" toast covers no mine column, no chat and no composer', async () => {
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
    await muteAppAudio(app)

    // One mine at work and its dwarf's chat, carried into Valle's Control room by "▲ Valle".
    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    const { dwarfId } = await launchClaude(window, mineId)
    const nav = window.locator('nav.dm-nav')
    await nav.locator('.dm-slot[data-label="Map"]').click()
    await window.locator('.dm-marker').first().click({ timeout: 60_000 })
    await window.locator(`.dm-roster [data-dwarf="${dwarfId}"]`).click({ timeout: 30_000 })
    await expect(window.locator(`.dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible({
      timeout: 15_000
    })
    await nav.locator('[aria-label="Mode"] .dm-slot[data-label="▲ Valle"]').click()
    const valle = await vallePage(app)
    await valle.waitForSelector('[data-valle-root]')
    await valleSettled(valle)
    await expect(valle.locator(`[data-valle-column="${mineId}"]`)).toBeVisible({ timeout: 15_000 })
    await expect(valle.locator(`[data-valle-chat="${dwarfId}"] .dm-composer`)).toBeVisible({
      timeout: 15_000
    })

    // The CI display, 1024×768: the mine column fills most of the main zone.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('mode=valle')
      )
      window?.setBounds({ ...window.getBounds(), width: 1024, height: 768 })
    })
    await expect
      .poll(() => valle.evaluate('window.innerWidth'), { timeout: 10_000 })
      .toBeLessThanOrEqual(1024)
    await valleSettled(valle)

    // "⋯" › "Reset preset": its toast.
    await valle.getByRole('button', { name: 'Preset options' }).click()
    await valle.getByRole('menuitem', { name: 'Reset preset' }).click()
    await valleSettled(valle)
    const toast = valle.locator('.dm-toasts').getByText('Control room is back to its preset')
    await expect(toast).toBeVisible()
    // Its rise ends 140 ms after it arrives (US-SHELL-012): the box is read where it stands.
    await valle.waitForTimeout(400)
    await shot(valle, 'valle-toast')
    const shown = await boxOf(toast)

    const columns = await boxesOf(valle, '[data-valle-column]')
    expect(columns.length, 'the mine column is drawn').toBeGreaterThan(0)
    for (const column of columns) expect(apart(shown, column), 'over a mine column').toBe(true)
    expect(apart(shown, await boxOf(valle.locator('.dm-valle__chats'))), 'over the chats').toBe(
      true
    )
    for (const composer of await boxesOf(valle, '.dm-composer')) {
      expect(apart(shown, composer), 'over a composer').toBe(true)
    }
  })
})
