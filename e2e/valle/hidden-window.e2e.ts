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
import { createClaudeStreamWorld, launchClaude, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (VQA-09; ADR-025 item 7; 07 S39.04, S39.05; US-VALLE-010): a Valle window moved away from is hidden, and it says so
 * whatever its page's own `visibilityState` reports: its on-screen report (A-44) empties, so the Host never counts a
 * mine as seen in a window nobody sees. The same holds after a second show and hide.
 *
 * Every page is muted first (`showValle`). The page's own scripts are strings: the e2e project has no DOM types.
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

/** Valle's on-screen reports (A-44) as the main process receives them, beside the app's own handler. */
async function watchValleReports(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const reports: string[][] = []
    ;(globalThis as unknown as { dwarfaiE2eValleReports: typeof reports }).dwarfaiE2eValleReports =
      reports
    ipcMain.on('presence:visibleMines', (event, request: unknown) => {
      if (!event.sender.getURL().includes('mode=valle')) return
      reports.push([...((request as { mineIds?: string[] } | null)?.mineIds ?? [])])
    })
  })
}

/** The mines Valle's last report held, or `null` before any. */
const lastReport = (app: ElectronApplication): Promise<string[] | null> =>
  app.evaluate(
    () =>
      (globalThis as unknown as { dwarfaiE2eValleReports?: string[][] }).dwarfaiE2eValleReports?.at(
        -1
      ) ?? null
  )

test.describe('a hidden Valle window (VQA-09)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-010.AC01, S39.05] once Valle is moved away from, its on-screen report empties; shown again it reports its mine, hidden again it empties', async () => {
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

    // One mine at work: Valle's Control room shows its column.
    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    await launchClaude(window, mineId)
    await watchValleReports(app)

    for (const round of [1, 2]) {
      const valle = await showValle(app, window)
      await valleSettled(valle)
      await expect
        .poll(() => lastReport(app), {
          timeout: 15_000,
          message: `round ${round}: Valle reports its mine on screen`
        })
        .toEqual([mineId])

      // The Panel shown: Valle is hidden, and says so.
      const moved = (await valle.evaluate("window.api.moveToMode({ mode: 'panel' })")) as {
        ok: boolean
      }
      expect(moved.ok).toBe(true)
      await expect.poll(() => shownModes(app), { timeout: 30_000 }).toEqual(['panel'])
      await expect
        .poll(() => lastReport(app), {
          timeout: 15_000,
          message: `round ${round}: a hidden Valle reports nothing on screen`
        })
        .toEqual([])
    }
  })
})
