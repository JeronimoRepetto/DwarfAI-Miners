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
 * L9 (ISSUE-284; 07 S10.08, S10.09; ADR-025 item 3): hiding the Panel and bringing it back are runs of UI main's
 * `ModeCoordinator`, to and from `hidden`, and the Panel comes back on the page and mine it showed. The OS's global
 * shortcut cannot be pressed from the harness, so the case drives the two other entries of the same runs: Settings
 * "Hide panel" (A-01, which the shortcut's hide shares) and the tray's Open (the shortcut's restore). The runs are the
 * coordinator's: the Panel's renderer is told each one (A-N14). The Veta ⇄ Panel case is ISSUE-293's (lead decision
 * 2026-09-30). The page's own scripts are strings: the e2e project has no DOM types.
 */

/** Records every `mode.transition` the Panel's renderer is told, from now on. */
const LISTEN_TO_RUNS = `(() => {
  window.__runs = []
  window.api.onModeTransition((t) => window.__runs.push({ from: t.from, to: t.to, role: t.role }))
})()`

test.describe.configure({ timeout: 180_000 })

test.describe('the Panel hidden and restored through the ModeCoordinator (ISSUE-284)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
  })

  test('[S10.08, S10.09] the global shortcut hides the Panel through the coordinator and restores it on the same page and mine', async () => {
    launched = await launchApp({ trayProbe: true, tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)
    const shownAt = await window.evaluate('location.href')
    await window.evaluate(LISTEN_TO_RUNS)
    const shownText = await window.locator('main, body').first().innerText()

    // Hide: a run from the Panel to hidden; the window goes once its renderer answered (or the watchdog fired).
    await window.evaluate('window.api.hidePanel()')
    await expect.poll(() => anyWindowVisible(app), { timeout: 10_000 }).toBe(false)

    // Restore: a run from hidden to lastMode, the Panel, on the same page and mine.
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await expect.poll(() => anyWindowVisible(app), { timeout: 10_000 }).toBe(true)
    expect(await window.evaluate('location.href')).toBe(shownAt)
    expect(await window.locator('main, body').first().innerText()).toBe(shownText)
    await expect.poll(() => window.evaluate('document.documentElement.style.opacity')).toBe('')

    // Both moves were the coordinator's runs, to and from hidden, told to the Panel.
    expect(await window.evaluate('window.__runs')).toEqual([
      { from: 'panel', to: 'hidden', role: 'source' },
      { from: 'hidden', to: 'panel', role: 'target' }
    ])
  })
})
