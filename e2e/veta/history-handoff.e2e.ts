import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
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
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { declareMine, risenContent, showVeta } from '../support/veta.ts'

/**
 * L9 (ISSUE-293; AMENDMENT-27, owner 2026-10-24; 07 S24.13, S27.01; decision "Veta history"; US-DLG-006.AC02): in the
 * E2E build profile (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a mine-history request from a chat risen in
 * Veta moves the app to the Panel on that mine's history, on that dwarf's tab, the chat's draft kept: opening the dwarf's
 * chat in the Panel afterwards shows it. Veta has no history of its own, so it is a source of the history slot only. A
 * stub Claude dwarf (never a real provider CLI) has said one thing, so the history has its tab.
 */

test.describe.configure({ timeout: 300_000 })

/** Which mode window is shown: `panel`, `veta`, both or none. */
function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => (w.webContents.getURL().includes('mode=veta') ? 'veta' : 'panel'))
      .sort()
  )
}

test.describe('the history hand-off from Veta to the Panel (ISSUE-293, AMENDMENT-27)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[US-DLG-006.AC02, S24.13] a mine-history request in a Veta chat lands the Panel on that mine's history on the dwarf's tab, and the dwarf's chat opened afterwards shows the draft", async () => {
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
    // One exchange, so the mine's history has this dwarf's tab.
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId,
        text: 'Look at the seam under the third pillar.',
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true })
    await expect
      .poll(async () => (await chatOf(window, dwarfId)).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2)

    // The chat rises in Veta with a draft.
    const veta = await showVeta(app, window)
    const dwarf = veta.locator(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    await dwarf.click()
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    await veta
      .locator('[data-veta-risen] .dm-msg textarea')
      .pressSequentially('half a thought about the seam')

    // "Mine history" in the chat's ⋯ menu: the Panel opens on the history, not on the chat.
    await veta.locator('[data-veta-risen] .dm-msg__tools button[title="More"]').click()
    await veta.getByRole('menuitem', { name: 'Mine history' }).click()
    await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['panel'])
    const history = window.locator('.dm-hist')
    await expect(history).toBeVisible({ timeout: 15_000 })
    await expect(window.locator('.dm-msg')).toHaveCount(0)
    // On this dwarf's tab.
    await expect(history.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute(
      'data-id',
      dwarfId,
      { timeout: 15_000 }
    )

    // The draft was kept for when that chat opens in the Panel.
    await window.locator(`button.dm-dwarf[data-dwarf="${dwarfId}"]`).click()
    await expect(window.locator(`.dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible({
      timeout: 15_000
    })
    await expect(window.locator('.dm-msg .dm-composer textarea')).toHaveValue(
      'half a thought about the seam',
      { timeout: 15_000 }
    )
  })
})
