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
import { createClaudeStreamWorld, hostSection, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { answerFolderPicker, showVeta } from '../support/veta.ts'

/**
 * L9 (ISSUE-295; 07 machine 20 S20.01, S20.05, S20.13, machine 22 S22.08, S22.10–S22.13, S22.16; UC-052; US-VETA-010;
 * 17 §1.9): on a fresh isolated profile, in the E2E build profile whose built-modes list contains Veta
 * (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), Veta is on its first run: the closed entrance carries "+".
 * Its click opens the empty mine picker with "Add a mine" as its only action; a cancelled OS folder picker adds nothing
 * and leaves the empty picker; Esc closes it and gives the focus back to "+". "Add a mine" with a folder makes it the
 * first mine and Veta hands off to the Panel, which opens with that mine in its mine column and no Add panel; Veta's
 * entrance is the ordinary one from then on.
 *
 * The OS folder picker is answered in the main process, so no native dialog shows. Screenshots go to
 * `DWARFAI_E2E_SHOTS` when it names a folder (a person's live check); nothing is written otherwise. The page's own
 * scripts are strings: the e2e project has no DOM types.
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

/** Saves a screenshot of `page` as `name` when `DWARFAI_E2E_SHOTS` names a folder. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['DWARFAI_E2E_SHOTS']
  if (dir === undefined || dir === '') return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

/** Whether the focused element of `page` is the Veta entrance. */
const entranceFocused = (veta: Page): Promise<boolean> =>
  veta.evaluate(
    `document.activeElement?.hasAttribute('data-veta-entrance') === true`
  ) as Promise<boolean>

test.describe('the first mine from Veta (ISSUE-295)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-010.AC02, US-VETA-010.AC03] on a fresh profile a person clicks + in Veta, adds a folder and lands in the Panel on that mine', async () => {
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
    expect(await hostSection<unknown[]>(window, 'mines').then((pages) => pages.flat())).toEqual([])

    // First run: the closed entrance carries "+" (S20.01).
    const veta = await showVeta(app, window)
    const entrance = veta.locator('[data-veta-entrance]')
    await expect(entrance).toHaveAttribute('data-first', 'true', { timeout: 30_000 })
    await expect(entrance.locator('[data-veta-plus]')).toHaveCount(1)
    await shot(veta, '1-first-run-plus')

    // "+" opens the empty picker, "Add a mine" its only action (S20.13, S22.08).
    await entrance.click()
    const picker = veta.locator('[data-mine-picker]')
    await expect(picker).toBeVisible({ timeout: 15_000 })
    await expect(picker.locator('[role="option"]')).toHaveCount(0)
    await expect(picker.locator('button:not([hidden])')).toHaveText(['Add a mine'])
    await shot(veta, '2-empty-picker')

    // The OS folder picker cancelled: nothing added, the empty picker again (S22.11); Esc gives "+" the focus (S22.16).
    await answerFolderPicker(app, null)
    await picker.locator('[data-picker-add]').click()
    await expect(picker).toBeVisible()
    await expect(picker.locator('[role="option"]')).toHaveCount(0)
    expect(await hostSection<unknown[]>(window, 'mines').then((pages) => pages.flat())).toEqual([])
    await veta.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect.poll(() => entranceFocused(veta), { timeout: 15_000 }).toBe(true)
    await expect(entrance).toHaveAttribute('data-first', 'true')
    await shot(veta, '3-cancel-focus-back')

    // A folder picked: the first mine, and the Panel opens on it with no Add panel (S22.12, S22.13).
    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    await answerFolderPicker(app, folder)
    await entrance.click()
    await expect(picker).toBeVisible({ timeout: 15_000 })
    await picker.locator('[data-picker-add]').click()
    await expect.poll(() => shownModes(app), { timeout: 30_000 }).toEqual(['panel'])
    const mines = await hostSection<Array<{ id: string; name: string }>>(window, 'mines').then(
      (pages) => pages.flat()
    )
    expect(mines.map((mine) => mine.name)).toEqual(['moria'])
    const mineId = mines[0]!.id
    await expect(window.locator(`.dm-minecol[data-mine="${mineId}"]`)).toBeVisible({
      timeout: 30_000
    })
    await expect(window.locator('.dm-add')).toHaveCount(0)
    await shot(window, '4-panel-on-the-mine')

    // The "+" never returns: Veta's entrance is the ordinary one now (S20.05).
    await expect(entrance).toHaveAttribute('data-first', 'false', { timeout: 30_000 })
    await expect(entrance.locator('[data-veta-plus]')).toHaveCount(0)
  })
})
