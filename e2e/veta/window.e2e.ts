import { expect, test } from '@playwright/test'
import {
  anyWindowVisible,
  chooseTrayItem,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'

/**
 * L9 (ISSUE-285; ADR-025 items 1, 4, 6; NFR-PLAT-02; 17 §1.9): in the E2E build profile, whose built-modes list
 * contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a move to Veta opens the Veta window through
 * the `ModeCoordinator`: its own renderer of the same bundle (`?mode=veta`), frameless (its content fills its
 * bounds), always on top, and inside the work area of its display, so the taskbar, Dock or panel stays uncovered. The
 * lever that moves a person there is ISSUE-294's, so the case asks for the move the way the lever will (A-N13 from
 * the Panel's renderer). A release build has no Veta: there the move is refused, and this case fails saying so.
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

/** What Electron main reports of the Veta window, read in the main process. */
interface VetaWindowFacts {
  readonly found: boolean
  readonly visible: boolean
  readonly alwaysOnTop: boolean
  readonly bounds: { x: number; y: number; width: number; height: number }
  readonly content: { x: number; y: number; width: number; height: number }
  readonly workArea: { x: number; y: number; width: number; height: number }
}

test.describe.configure({ timeout: 180_000 })

test.describe('the Veta window (ISSUE-285)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
  })

  test('[NFR-PLAT-02, ADR-025] the Veta window opens frameless and always on top, inside the work area of its display', async () => {
    launched = await launchApp({ trayProbe: true, tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const moved = (await window.evaluate("window.api.moveToMode({ mode: 'veta' })")) as {
      ok: boolean
    }
    expect(moved, 'the build lists Veta: build it with DWARFAI_BUILD_PROFILE=e2e').toEqual({
      ok: true,
      value: undefined
    })

    const facts = async (): Promise<VetaWindowFacts> =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const veta = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.getURL().includes('mode=veta')
        )
        const none = { x: 0, y: 0, width: 0, height: 0 }
        if (veta === undefined) {
          return {
            found: false,
            visible: false,
            alwaysOnTop: false,
            bounds: none,
            content: none,
            workArea: none
          }
        }
        const bounds = veta.getBounds()
        return {
          found: true,
          visible: veta.isVisible(),
          alwaysOnTop: veta.isAlwaysOnTop(),
          bounds,
          content: veta.getContentBounds(),
          workArea: screen.getDisplayMatching(bounds).workArea
        }
      })
    await expect.poll(async () => (await facts()).visible, { timeout: 10_000 }).toBe(true)
    const veta = await facts()
    expect(veta.found).toBe(true)
    expect(veta.alwaysOnTop).toBe(true)
    // Frameless: no title bar or border, so the page fills the window.
    expect(veta.content).toEqual(veta.bounds)
    // Inside the work area of its display: the taskbar, Dock or panel is never covered.
    expect(veta.bounds.x).toBeGreaterThanOrEqual(veta.workArea.x)
    expect(veta.bounds.y).toBeGreaterThanOrEqual(veta.workArea.y)
    expect(veta.bounds.x + veta.bounds.width).toBeLessThanOrEqual(
      veta.workArea.x + veta.workArea.width
    )
    expect(veta.bounds.y + veta.bounds.height).toBeLessThanOrEqual(
      veta.workArea.y + veta.workArea.height
    )
  })
})
