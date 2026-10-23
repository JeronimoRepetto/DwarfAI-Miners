import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
import { declareMine, risenContent } from '../support/veta.ts'

/**
 * L9 (VQA-08; US-SHELL-001.AC01; 07 S28.21, S24.18, machine 9; ADR-025 item 3): early in a session a person climbs from
 * the Panel to Valle with a chat open, and at once presses Valle's "▼ Veta". The app moves into Veta, which has never been
 * shown in this session, and the chat in focus rises there, as a click on its dwarf raises it. The Veta window is built by
 * that first press, so its renderer has not read the Host's facts yet when the run lands.
 *
 * Every page is muted first. The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 300_000 })

/** The modes whose window is on screen, read in the main process. */
function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.isVisible())
      .map((w) => {
        const url = w.webContents.getURL()
        return url.includes('mode=valle') ? 'valle' : url.includes('mode=veta') ? 'veta' : 'panel'
      })
      .sort()
  )
}

/** The page whose URL holds `mode=<mode>`, once Playwright lists it. */
async function pageOf(app: ElectronApplication, mode: 'valle' | 'veta'): Promise<Page> {
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes(`mode=${mode}`))
        return page !== undefined
      },
      { timeout: 15_000, message: `Playwright lists the ${mode} page` }
    )
    .toBe(true)
  return page!
}

test.describe('Valle "▼ Veta" early in a session (VQA-08)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SHELL-001.AC01, S24.18] "▼ Veta" pressed as soon as Valle opens raises the chat in focus in a Veta window built by that press', async () => {
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

    // One mine at work and its dwarf's chat open in the Panel.
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
    // No Veta window yet: this session has never shown Veta.
    expect(app.windows().some((p) => p.url().includes('mode=veta'))).toBe(false)

    // "▲ Valle" carries the chat into Valle, pinned and focused.
    await nav.locator('[aria-label="Mode"] .dm-slot[data-label="▲ Valle"]').click()
    const valle = await pageOf(app, 'valle')
    await valle.waitForSelector('[data-valle-root]')
    await valleSettled(valle)
    await expect(valle.locator('.dm-cstack__open')).toHaveAttribute('data-pin', dwarfId, {
      timeout: 15_000
    })

    // At once "▼ Veta": Veta alone on screen, and the carried chat risen there.
    await valle.locator('[data-lever="veta"]').click()
    await expect
      .poll(() => shownModes(app), { timeout: 30_000, message: '"▼ Veta" moves the app into Veta' })
      .toEqual(['veta'])
    const veta = await pageOf(app, 'veta')
    await veta.waitForSelector('[data-veta-root]')
    await expect
      .poll(() => risenContent(veta), {
        timeout: 15_000,
        message: 'the chat in focus rises in Veta (S24.18)'
      })
      .toBe('chat')
    await expect(veta.locator(`[data-veta-risen] .dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible()
  })
})
