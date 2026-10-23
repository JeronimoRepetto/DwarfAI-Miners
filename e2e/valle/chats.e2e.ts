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
import {
  chatOf,
  createClaudeStreamWorld,
  launchClaude,
  REPLIES,
  stubOnlyPath
} from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (a Valle package gap resolved in development, EPIC-20 task TVC; 07 machines 29, 30, 33; US-VALLE-007,
 * US-VALLE-008, US-VALLE-005.AC08, US-MSG-015.AC02, AC06): in the E2E build profile (Valle in its built-modes list,
 * docs/e2e.md), two stub Claude dwarfs pinned in Valle show their conversations, the Panel's own MessagePanel, in the
 * Control room's expanded line; a message typed there reaches the stub session. In the Work front's split at its
 * narrowest, each pane's MessagePanel fills its 317 px pane, its own min-content floor, and the chat zone stays at the
 * splitter's 640 px minimum: the panel never widens Valle's minimums. Widths are read from the laid-out page. The pins
 * are written through A-N21 from the Panel before Valle opens, so the case starts with both chats already pinned (a
 * dwarf pressed in a zone pins its chat too, covered by the Valle root's unit cases).
 */

test.describe.configure({ timeout: 300_000 })

/** A laid-out width, in whole px. */
async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'laid out').not.toBeNull()
  return Math.round(box!.width)
}

/** Whether an element's content overflows its own box sideways. */
function overflows(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e === null || e.scrollWidth > e.clientWidth + 1 })()`
  ) as Promise<boolean>
}

test.describe("the chats inside Valle's pins and panes (TVC)", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-007.AC08, US-VALLE-005.AC08, US-MSG-015.AC02, US-MSG-015.AC06] a person reads and writes a pinned chat in Valle, and the split panes hold the panel at its 317 px floor', async () => {
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
    const first = await launchClaude(window, mineId)
    const second = await launchClaude(window, mineId)
    const pins = [first.dwarfId, second.dwarfId].map((dwarfId, order) => ({
      dwarfId,
      mineId,
      order
    }))
    const written = (await window.evaluate(
      `window.api.setUiPreference(${JSON.stringify({ key: 'pins', value: pins })})`
    )) as unknown
    expect(written, 'A-N21 takes the pins').toBeTruthy()

    const valle = await showValle(app, window)
    await valleSettled(valle)

    // The Control room's expanded line holds the first dwarf's conversation, the stub's first reply in it.
    const open = valle.locator('.dm-cstack__open')
    await expect(open).toHaveAttribute('data-pin', first.dwarfId, { timeout: 30_000 })
    const panel = open.locator('> .dm-msg')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.dm-msg__log')).toContainText(REPLIES.first, { timeout: 30_000 })

    // A message typed there reaches the stub session, and its reply comes back into the same panel.
    const composer = panel.locator('.dm-composer textarea')
    await composer.fill('Read the notes.')
    await composer.press('Enter')
    await expect
      .poll(async () => (await chatOf(window, first.dwarfId)).map((row) => row.text), {
        timeout: 60_000,
        message: 'the Host holds the words the stub took'
      })
      .toContain('Read the notes.')
    await expect(panel.locator('.dm-msg__log')).toContainText(REPLIES.plain, { timeout: 60_000 })

    // The same layout room on any runner's screen: the Valle window at 1024 × 768 inside its work area, drawn at the
    // zoom that gives its page 1700 CSS px across, room for the split's 640 px beside the mine at its minimum. Every
    // width below is in CSS px, the unit the design and machine 33 state.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('mode=valle')
      )!
      const area = screen.getDisplayMatching(window.getBounds()).workArea
      window.setContentBounds({ x: area.x, y: area.y, width: 1024, height: 768 })
      window.webContents.setZoomFactor(1024 / 1700)
    })
    await expect
      .poll(() => valle.evaluate('Math.round(window.innerWidth)'), { timeout: 10_000 })
      .toBe(1700)

    // The Work front, its split on, the chat zone at the splitter's minimum: two panes of 317 px each.
    await valle.locator('[data-preset-tab="front"]').click()
    await valleSettled(valle)
    const split = valle.locator('button.dm-cdeck__split')
    await expect(split).toBeEnabled({ timeout: 15_000 })
    await split.click()
    const panes = valle.locator('.dm-cdeck__pane')
    await expect(panes).toHaveCount(2)
    const bar = valle.getByRole('separator', { name: 'Resize the chats' })
    await bar.focus()
    await valle.keyboard.press('Home')
    await expect(bar).toHaveAttribute('aria-valuenow', '640')
    await expect.poll(() => widthOf(valle.locator('.dm-valle__chats'))).toBe(640)
    for (const pane of await panes.all()) {
      const hosted = pane.locator('> .dm-msg')
      await expect(hosted).toBeVisible()
      expect(await widthOf(pane)).toBe(317)
      // The panel fills its pane exactly: its min-content fits 317 px, so nothing in it spills past the pane.
      expect(await widthOf(hosted)).toBe(317)
    }
    expect(await overflows(valle, '.dm-cdeck__panes')).toBe(false)
    expect(await overflows(valle, '.dm-valle__chats')).toBe(false)
    // Valle's minimum is the splitter's own, unmoved by the panels it holds.
    await expect(bar).toHaveAttribute('aria-valuemin', '640')
  })
})
