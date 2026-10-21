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

/**
 * L9 (ISSUE-286; 07 machine 21; US-VETA-002; NFR-PLAT-03; 17 §1.9): in the E2E build profile, whose built-modes list
 * contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), Veta dropped near each edge of its display
 * snaps flush against that edge of the work area (vertical on a side edge), and after a relaunch over the same profile
 * it comes back to the place it was left at.
 *
 * The drop is the grip's own seam A requests (A-N23 `drag-start`, then `drag-end` at a screen point), sent from the
 * Veta renderer: a synthetic pointer cannot follow the window as it grows to the drag surface, and the gesture itself
 * (the 5 px threshold, the preview, the cancels) is proven at L1 (`dockGesture.test.ts`). The second-monitor and unplug
 * cases stay real-machine release checks (17 §1.13). The page's own scripts are strings: the e2e project has no DOM
 * types.
 */

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The Veta window's bounds and the work area of the display it is on, read in the main process. */
interface VetaFacts {
  readonly visible: boolean
  readonly bounds: Rect
  readonly workArea: Rect
}

test.describe.configure({ timeout: 300_000 })

async function vetaFacts(app: ElectronApplication): Promise<VetaFacts | null> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const veta = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('mode=veta')
    )
    if (veta === undefined) return null
    const bounds = veta.getBounds()
    return {
      visible: veta.isVisible(),
      bounds,
      workArea: screen.getDisplayMatching(bounds).workArea
    }
  })
}

/** Opens Veta the way the lever will (A-N13 from the Panel's renderer) and answers its page once it is shown. */
async function showVeta(app: ElectronApplication, panel: Page): Promise<Page> {
  const moved = (await panel.evaluate("window.api.moveToMode({ mode: 'veta' })")) as { ok: boolean }
  expect(moved.ok, 'the build lists Veta: build it with DWARFAI_BUILD_PROFILE=e2e').toBe(true)
  await expect
    .poll(async () => (await vetaFacts(app))?.visible ?? false, { timeout: 15_000 })
    .toBe(true)
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes('mode=veta'))
        return page !== undefined
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  // AMENDED for ISSUE-287 (was: waited for the grip): a fresh profile has no mine, so Veta shows the closed entrance,
  // its one part (07 machine 20 `first-run`); the drops below are the grip's own seam A requests either way.
  await page!.waitForSelector('[data-veta-entrance], [data-veta-grip]')
  return page!
}

/** Drops Veta at a screen point the way its grip does: the drag surface first, then the release. */
async function dropAt(veta: Page, x: number, y: number): Promise<{ applied: boolean }> {
  await veta.evaluate(`window.api.layoutVeta({ kind: 'drag-start', screenX: ${x}, screenY: ${y} })`)
  return (await veta.evaluate(
    `window.api.layoutVeta({ kind: 'drag-end', screenX: ${x}, screenY: ${y} })`
  )) as { applied: boolean }
}

async function open(profile: IsolatedProfile): Promise<{ launched: LaunchedApp; veta: Page }> {
  const launched = await launchApp({
    profile,
    trayProbe: true,
    tracePath: test.info().outputPath(`trace-${Date.now()}.zip`)
  })
  const { app, window } = launched
  await waitForHostAttached(profile)
  await chooseTrayItem(app, TRAY_ITEMS.open)
  await answerFirstRunStep(window)
  await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)
  return { launched, veta: await showVeta(app, window) }
}

test.describe('the Veta dock (ISSUE-286)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-002.AC02, US-VETA-002.AC05, NFR-PLAT-03] Veta dragged to each edge snaps there and returns to the same place after a relaunch', async () => {
    profile = createIsolatedProfile()
    const first = await open(profile)
    launched = first.launched
    const { app } = first.launched
    const start = await vetaFacts(app)
    expect(start).not.toBeNull()
    const area = start!.workArea
    const midX = Math.round(area.x + area.width * 0.3)
    const midY = Math.round(area.y + area.height * 0.7)
    const drops = [
      { edge: 'top', x: midX, y: area.y + 3 },
      { edge: 'right', x: area.x + area.width - 3, y: midY },
      { edge: 'bottom', x: midX, y: area.y + area.height - 3 },
      { edge: 'left', x: area.x + 3, y: midY }
    ] as const
    let last: Rect | undefined
    for (const drop of drops) {
      expect((await dropAt(first.veta, drop.x, drop.y)).applied, drop.edge).toBe(true)
      await expect
        .poll(async () => (await vetaFacts(app))?.bounds.width ?? 0, { timeout: 5_000 })
        .toBeLessThan(area.width)
      const { bounds } = (await vetaFacts(app))!
      // Flush against that edge of the work area, never over the taskbar, Dock or panel; vertical on a side edge.
      if (drop.edge === 'top') expect(bounds.y, drop.edge).toBe(area.y)
      if (drop.edge === 'bottom')
        expect(bounds.y + bounds.height, drop.edge).toBe(area.y + area.height)
      if (drop.edge === 'left') expect(bounds.x, drop.edge).toBe(area.x)
      if (drop.edge === 'right')
        expect(bounds.x + bounds.width, drop.edge).toBe(area.x + area.width)
      const vertical = drop.edge === 'left' || drop.edge === 'right'
      expect(bounds.height > bounds.width, drop.edge).toBe(vertical)
      expect(bounds.x).toBeGreaterThanOrEqual(area.x)
      expect(bounds.y).toBeGreaterThanOrEqual(area.y)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height)
      last = bounds
    }

    // Relaunched over the same profile: Veta comes back to the place it was left at, on the same display. The Panel is
    // the mode left shown, so the next launch opens on it and the case moves to Veta the same way again.
    await first.veta.evaluate("window.api.moveToMode({ mode: 'panel' })")
    await first.launched.teardown({ stopEverything: true })
    launched = undefined
    const second = await open(profile)
    launched = second.launched
    await expect
      .poll(async () => (await vetaFacts(second.launched.app))?.bounds, { timeout: 10_000 })
      .toEqual(last)
  })
})
