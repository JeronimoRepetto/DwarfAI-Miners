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
import { showValle, valleFacts } from '../support/valle.ts'

/**
 * L9 (ISSUE-299; 07 S39.01; ADR-025 item 1; US-VALLE-001.AC10; 17 §1.9): in the E2E build profile, whose built-modes
 * list contains Valle (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a move to Valle from the Panel opens the
 * Valle window through the `ModeCoordinator`: its own renderer of the same bundle (`?mode=valle`), frameless, not
 * always on top, on the display of the Panel and over that display's work area, so the taskbar, Dock or panel stays
 * uncovered (`VALLE_BOUNDS = 'work-area'`). The lever is ISSUE-311's, so the case asks for the move the way the lever
 * will (A-N13 from the Panel's renderer). A release build has no Valle: there the move is refused, and this case fails
 * saying so. The second-monitor case is a real-machine release check (17 §1.13).
 */

test.describe.configure({ timeout: 180_000 })

test.describe('the Valle window (ISSUE-299)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
  })

  test("[US-VALLE-001.AC10, S39.01] entering Valle from the Panel opens it on the Panel's display, on its work area", async () => {
    launched = await launchApp({ trayProbe: true, tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const valle = await showValle(app, window)
    await expect.poll(async () => (await valleFacts(app)).visible, { timeout: 10_000 }).toBe(true)
    const facts = await valleFacts(app)
    expect(facts.found).toBe(true)
    expect(facts.alwaysOnTop).toBe(false)
    // Frameless: no title bar or border, so the page fills the window.
    expect(facts.content).toEqual(facts.bounds)
    // On the Panel's display, over its work area: the taskbar, Dock or panel is never covered.
    expect(facts.display).toBe(facts.sourceDisplay)
    expect(facts.bounds).toEqual(facts.sourceWorkArea)
    // The Valle root mounted with its stores read; it draws no copy of its own yet.
    expect(await valle.locator('[data-valle-root]').count()).toBe(1)
  })
})
