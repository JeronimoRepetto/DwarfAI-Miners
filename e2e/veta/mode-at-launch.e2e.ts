import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
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
// The one built-modes list (17 §1.9): what the build under test offers, from the profile it was built with.
import { builtModesOf } from '../../src/contracts/ipc/builtModes.ts'

/**
 * L9 (ISSUE-294; US-SHELL-001.AC02, AC03, AC04; US-SET-002.AC09; 07 S10.01, S10.04, S10.13; ADR-034 item 2): the Panel's
 * "▼ Veta" moves the app into Veta and Veta becomes the mode last used; with Settings › General "Mode at launch" on
 * "Last used" the next launch opens in Veta, and with "Panel" pinned it opens the Panel whatever was last used. Each
 * launch shares one profile, as one person's app does across restarts; the window opens when the person opens the app
 * (the tray's Open, S10.13), which is when "Mode at launch" decides it. Built with the release or the E2E profile:
 * both ship Veta.
 */

test.describe.configure({ timeout: 300_000 })

/** "Mode at launch"'s options in the build under test (docs/e2e.md: the E2E profile unless another is named). */
const LABELS = { panel: 'Panel', veta: 'Veta', valle: 'Valle' } as const
const OPTIONS = [
  'Last used',
  ...builtModesOf(process.env.DWARFAI_BUILD_PROFILE ?? 'e2e').map((mode) => LABELS[mode])
]

/** The modes whose window is on screen, read in the main process: Veta's renderer is `?mode=veta`, the Panel's not. */
function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.isVisible())
      .map((w) => (w.webContents.getURL().includes('mode=veta') ? 'veta' : 'panel'))
      .sort()
  )
}

/** Opens the app from the tray, as the person does, and waits for the one mode window it opens. */
async function openFromTray(app: ElectronApplication, mode: 'panel' | 'veta'): Promise<void> {
  await chooseTrayItem(app, TRAY_ITEMS.open)
  await expect
    .poll(() => shownModes(app), { timeout: 30_000, message: `the app opens in ${mode}` })
    .toEqual([mode])
}

/** "▼ Veta" on the Panel's nav lever, then Veta alone on screen. */
async function pressVeta(app: ElectronApplication, panel: Page): Promise<void> {
  await panel.locator('nav.dm-nav [aria-label="Mode"] .dm-slot[data-label="▼ Veta"]').click()
  await expect
    .poll(() => shownModes(app), { timeout: 30_000, message: '▼ Veta moves the app into Veta' })
    .toEqual(['veta'])
}

test.describe('Mode at launch (ISSUE-294)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  /** Launches the app on the case's profile; the previous launch is quit first, its Host left running (OQ-63). */
  async function relaunch(): Promise<LaunchedApp> {
    await launched?.teardown()
    launched = await launchApp({
      profile: profile!,
      trayProbe: true,
      tracePath: test.info().outputPath(`trace-${Date.now()}.zip`)
    })
    await waitForHostAttached(profile!)
    return launched
  }

  test('[US-SHELL-001.AC03, US-SET-002.AC09] with Last used, a relaunch after using Veta opens Veta; with Panel pinned it opens the Panel', async () => {
    profile = createIsolatedProfile()

    // First launch: the Panel (nothing used yet), then "▼ Veta".
    let { app, window } = await relaunch()
    await openFromTray(app, 'panel')
    await answerFirstRunStep(window)
    await pressVeta(app, window)

    // Relaunch with "Last used" (the default): Veta was last used, so the app opens in Veta.
    ;({ app, window } = await relaunch())
    await openFromTray(app, 'veta')

    // Back to the Panel, and "Mode at launch" pinned to Panel in Settings › General.
    const veta = app.windows().find((page) => page.url().includes('mode=veta'))!
    await veta.evaluate("window.api.moveToMode({ mode: 'panel' })")
    await expect.poll(() => shownModes(app), { timeout: 30_000 }).toEqual(['panel'])
    await window.locator('nav.dm-nav .dm-slot[data-label="Settings"]').click()
    await window.locator('[role="tab"][data-s="General"]').click()
    const select = window.locator('.dm-settings__panel select[aria-label="Mode at launch"]')
    await expect(select.locator('option')).toHaveText(OPTIONS)
    await select.selectOption('panel')
    await expect(select).toHaveValue('panel')
    // Veta used last once more, so only the pin can open the Panel next.
    await pressVeta(app, window)

    // Relaunch with Panel pinned: the Panel, whatever was last used.
    ;({ app } = await relaunch())
    await openFromTray(app, 'panel')
  })
})
