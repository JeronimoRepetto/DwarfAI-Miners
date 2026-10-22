import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/vetaScene.ts'

/**
 * L9 (ISSUE-300; US-VALLE-001.AC08, .AC09; NFR-PERS-13; 07 S28.02, S29.02, S32.02; ADR-024 items 1, 4): in the E2E build
 * profile (Valle in its built-modes list, docs/e2e.md), the Work front's layout changed in Valle, and the pins and the
 * mosaic order UI main holds, are back as left after the app is closed and opened again on the same profile. Pinning
 * and arranging the mosaic are later issues' (ISSUE-302, ISSUE-304), so the case writes those two stores the way UI main
 * keeps them (one JSON file each under `userData`) while the app is closed; two pins whose dwarfs the Host never knew
 * come back read-only `gone`, in their order (S18.05).
 */

test.describe.configure({ timeout: 300_000 })

/** UI main's Valle store files (`JsonUiPreferenceStore`, ISSUE-299). */
const LAYOUT_FILE = 'valle-layout-v1.json'
const PINS_FILE = 'valle-pins-v1.json'
const ORDER_FILE = 'valle-mosaic-order-v1.json'

/** Two dwarf ids (UUIDv7) the Host never knew: dwarfs whose sessions ended while the app was closed. */
const GONE_A = '01920000-0000-7000-8000-0000000e3001'
const GONE_B = '01920000-0000-7000-8000-0000000e3002'

/** The Valle window's page, polled: Playwright may list it a moment after main shows the window. */
async function vallePage(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes('mode=valle'))
        return page !== undefined
      },
      { timeout: 30_000, message: 'the app reopens in Valle, the mode used last' }
    )
    .toBe(true)
  await page!.waitForSelector('[data-valle-root]')
  return page!
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

test.describe('Valle presets across a restart (ISSUE-300)', () => {
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

  test('[US-VALLE-001.AC08, US-VALLE-001.AC09, NFR-PERS-13] a changed Work front layout, two pins and a mosaic order are back as left after closing and reopening the app', async () => {
    profile = createIsolatedProfile()
    const prefs = profile.userDataDir

    // First launch: two mines, then Valle, the Work front, and its list folded.
    const first = await relaunch()
    let app = first.app
    const window = first.window
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    const folders = ['first-mine', 'second-mine'].map((name) => path.join(profile!.root, name))
    for (const folder of folders) mkdirSync(folder)
    const firstMine = await declareMine(app, window, folders[0]!)
    const secondMine = await declareMine(app, window, folders[1]!)

    let valle = await showValle(app, window)
    const root = valle.locator('[data-valle-root]')
    await expect(root).toHaveAttribute('data-preset', 'control')
    await valle.getByRole('tab', { name: 'Work front' }).click()
    await expect(root).toHaveAttribute('data-preset', 'front')
    // AMENDED for ISSUE-301: the Work front tab dives into a mine, input ignored until the dive settles (S28.09).
    await valleSettled(valle)
    await valle.getByRole('button', { name: 'Fold the list' }).click()
    await expect(valle.getByRole('button', { name: 'Show the mines list' })).toHaveText('MINES')
    // UI main stored both at once (A-N21): the preset in use and the Work front's folded list.
    await expect
      .poll(() => readJson(path.join(prefs, LAYOUT_FILE)), { timeout: 10_000 })
      .toMatchObject({ front: { foldedList: true }, control: { foldedList: false } })
    await expect
      .poll(() => readJson(path.join(prefs, 'valle-preset-v1.json')), { timeout: 10_000 })
      .toEqual({ preset: 'front' })

    // Closed: two pins and a mosaic order, in UI main's own file shapes.
    await launched!.teardown()
    launched = undefined
    writeFileSync(
      path.join(prefs, PINS_FILE),
      JSON.stringify({
        pins: [
          { dwarfId: GONE_B, mineId: secondMine, order: 1 },
          { dwarfId: GONE_A, mineId: firstMine, order: 0 }
        ]
      })
    )
    writeFileSync(path.join(prefs, ORDER_FILE), JSON.stringify({ order: [secondMine, firstMine] }))

    // Reopened: Valle, the mode used last, on the Work front with its list folded.
    app = (await relaunch()).app
    await chooseTrayItem(app, TRAY_ITEMS.open)
    valle = await vallePage(app)
    const reopened = valle.locator('[data-valle-root]')
    await expect(reopened).toHaveAttribute('data-preset', 'front')
    await expect(valle.getByRole('button', { name: 'Show the mines list' })).toHaveText('MINES')
    // The pins in their order, both read-only gone: their dwarfs are not the Host's.
    await expect
      .poll(
        () =>
          valle.evaluate(
            "[...document.querySelectorAll('[data-pin]')].map((p) => [p.getAttribute('data-pin'), p.getAttribute('data-pin-state')])"
          ),
        { timeout: 30_000 }
      )
      .toEqual([
        [GONE_A, 'gone'],
        [GONE_B, 'gone']
      ])
    // The Control room's mosaic in the arranged order; the Work front's layout untouched by the switch.
    await valle.getByRole('tab', { name: 'Control room' }).click()
    await expect(reopened).toHaveAttribute('data-preset', 'control')
    await expect
      .poll(() =>
        valle.evaluate(
          "[...document.querySelectorAll('[data-valle-column]')].map((c) => c.getAttribute('data-valle-column'))"
        )
      )
      .toEqual([secondMine, firstMine])
    expect(readJson(path.join(prefs, LAYOUT_FILE))).toMatchObject({ front: { foldedList: true } })
  })
})
