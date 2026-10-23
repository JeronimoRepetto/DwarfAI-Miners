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
import {
  ASK_MARKER,
  asksOf,
  createClaudeStreamWorld,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (ISSUE-306; US-SHELL-010.AC08; 07 S39.05, S17.01; UC-064, UC-059): in the E2E build profile (Valle in its
 * built-modes list, docs/e2e.md), Valle's Control room shows three mines at 1024 × 768, the last one's column past the
 * mosaic's right edge. Two stub Claude dwarfs start asking for a permission: first one in the mine on screen, then one
 * in the mine scrolled out of view, which raises the level-3 notification, since a mine counts as on screen only inside
 * the visible viewport (PO #85). The level-3 decision is the Host's; Valle only reports what is on screen (A-44). The
 * counter and the footer's queue list both askers, oldest first.
 *
 * The OS notification is never drawn on the machine running the case: Electron's `Notification` is replaced in the main
 * process before any ask, recording what would have been shown (its title and body, the dwarf's and the mine's names).
 */

test.describe.configure({ timeout: 300_000 })

/** What the main process would have shown. */
interface Shown {
  title: string
  body: string
}

/**
 * Electron's `Notification` in the main process records instead of drawing: `isSupported` answers yes (a Linux runner
 * may have no notification daemon) and `show` keeps the title and body.
 */
async function recordNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const shown: Array<{ title: string; body: string }> = []
    ;(globalThis as unknown as { dwarfaiE2eShown: typeof shown }).dwarfaiE2eShown = shown
    Notification.isSupported = () => true
    Notification.prototype.show = function (this: { title: string; body: string }) {
      shown.push({ title: this.title, body: this.body })
    }
  })
}

const shownOf = (app: ElectronApplication): Promise<Shown[]> =>
  app.evaluate(() => [
    ...((globalThis as unknown as { dwarfaiE2eShown?: Shown[] }).dwarfaiE2eShown ?? [])
  ])

/** The stub dwarf asks for its Write tool (`claudeStreamStub.mjs` ASK_MARKER); answers once its ask is open. */
async function startAsking(window: Page, dwarfId: string): Promise<void> {
  const sent = (await window.evaluate(
    `window.api.sendDwarfText(${JSON.stringify({
      dwarfId,
      text: `Please write the ${ASK_MARKER}.`,
      attachments: [],
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { ok: boolean } }
  expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })
  await expect
    .poll(
      async () =>
        (await asksOf(window)).some((ask) => ask.dwarfId === dwarfId && ask.state === 'open'),
      { timeout: 60_000, message: 'the stub’s permission request opens an ask' }
    )
    .toBe(true)
}

/** How much of the column lies inside the mosaic's visible box, from the laid-out page. */
function visibleShare(valle: Page, mineId: string): Promise<number> {
  return valle.evaluate(`(() => {
    const mosaic = document.querySelector('.dm-valle__body [data-valle-mosaic]').getBoundingClientRect()
    const column = document.querySelector('.dm-valle__body [data-valle-column="${mineId}"]').getBoundingClientRect()
    const inside = Math.max(0, Math.min(column.right, mosaic.right) - Math.max(column.left, mosaic.left))
    return column.width === 0 ? 0 : inside / column.width
  })()`) as Promise<number>
}

test.describe('the needs-you queue and the on-screen rule in Valle (ISSUE-306)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[US-SHELL-010.AC08] a mine scrolled out of the Control room's viewport raises the level-3 notification when its dwarf starts asking", async () => {
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
    await recordNotifications(app)

    // "System notifications" on (A-43).
    await window.evaluate('window.api.setNotificationsEnabled(true)')
    await expect.poll(() => window.evaluate('window.api.getNotificationsEnabled()')).toBe(true)

    // Three mines; the first is on screen, the last lies past the mosaic's right edge.
    const mineIds: string[] = []
    for (const name of ['alpha', 'beta', 'gamma']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      mineIds.push(await declareMine(app, window, folder))
    }
    const [shownMine, , hiddenMine] = mineIds as [string, string, string]
    const onScreen = await launchClaude(window, shownMine)
    const offScreen = await launchClaude(window, hiddenMine)
    const order = (await window.evaluate(
      `window.api.setUiPreference(${JSON.stringify({ key: 'valleMosaicOrder', value: mineIds })})`
    )) as unknown
    expect(order, 'A-N21 takes the mosaic order').toBeTruthy()

    const valle = await showValle(app, window)
    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('mode=valle')
      )!
      const area = screen.getDisplayMatching(window.getBounds()).workArea
      window.setContentBounds({ x: area.x, y: area.y, width: 1024, height: 768 })
      window.webContents.setZoomFactor(1)
    })
    await valleSettled(valle)
    const root = valle.locator('.dm-valle__body')
    await expect(root.locator(`[data-valle-column="${hiddenMine}"]`)).toHaveCount(1, {
      timeout: 30_000
    })
    await expect.poll(() => visibleShare(valle, shownMine), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => visibleShare(valle, hiddenMine), { timeout: 15_000 }).toBeLessThan(0.5)

    // The dwarf in the mine on screen asks first.
    await startAsking(window, onScreen.dwarfId)
    // Then the dwarf in the mine scrolled out of view.
    await startAsking(window, offScreen.dwarfId)
    const counter = valle.locator('[data-needs-counter]')
    await expect(counter).toHaveAttribute('aria-label', '2 waiting on you. Jump to the next one', {
      timeout: 30_000
    })
    await expect(counter).toContainText('2 need you')
    await expect(valle.locator('.dm-vq__entry')).toHaveCount(2)
    await expect(valle.locator('.dm-vq__entry').first()).toHaveAttribute(
      'data-id',
      onScreen.dwarfId
    )

    // Level 3 for the mine out of view.
    await expect
      .poll(async () => (await shownOf(app)).map((n) => n.body), {
        timeout: 60_000,
        message: 'the Host raises level 3 for the mine scrolled out of view'
      })
      .toContain('gamma')

    // The counter jumps to the oldest, the dwarf on screen: its chat expanded in the stack, the preset unchanged.
    await counter.click()
    await expect(valle.locator('.dm-cstack__open')).toHaveAttribute('data-pin', onScreen.dwarfId)
    await expect(valle.locator('[data-valle-root]')).toHaveAttribute('data-preset', 'control')
  })
})
