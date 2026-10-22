import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
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
 * L9 (ISSUE-301; US-VALLE-002.AC01, US-VALLE-003.AC02; 07 S28.03, S28.08, S28.11, S28.12; UC-054; NFR-TIM-11): in the E2E
 * build profile (Valle in its built-modes list, docs/e2e.md), a person scrolls the Control room's mosaic sideways,
 * dives into a mine with its `⤢`, and climbs out with the "Control room" tab to the same scroll. Five mines make the
 * mosaic scroll past four columns. Arranging the mosaic is a later issue's (ISSUE-304), so the case writes the mosaic
 * order the way UI main keeps it (its JSON file under `userData`) while the app is closed, as `presets.e2e.ts` does.
 */

test.describe.configure({ timeout: 300_000 })

/** UI main's mosaic order file (`JsonUiPreferenceStore`, ISSUE-299). */
const ORDER_FILE = 'valle-mosaic-order-v1.json'

test.describe('the dive into a mine and the climb out (ISSUE-301)', () => {
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

  test('[US-VALLE-002.AC01, US-VALLE-003.AC02] a person scrolls the mosaic, dives into a mine and climbs out to the same scroll', async () => {
    profile = createIsolatedProfile()

    // First launch: five mines, so the mosaic scrolls past four columns.
    const first = await relaunch()
    await chooseTrayItem(first.app, TRAY_ITEMS.open)
    await answerFirstRunStep(first.window)
    const mines: string[] = []
    for (const name of ['mine-a', 'mine-b', 'mine-c', 'mine-d', 'mine-e']) {
      const folder = path.join(profile.root, name)
      mkdirSync(folder)
      mines.push(await declareMine(first.app, first.window, folder))
    }

    // Closed: the mosaic order, in UI main's own file shape.
    await launched!.teardown()
    launched = undefined
    writeFileSync(path.join(profile.userDataDir, ORDER_FILE), JSON.stringify({ order: mines }))

    const second = await relaunch()
    await chooseTrayItem(second.app, TRAY_ITEMS.open)
    const valle = await showValle(second.app, second.window)
    const root = valle.locator('[data-valle-root]')
    await expect(root).toHaveAttribute('data-preset', 'control')
    await expect(valle.locator('[data-valle-column]')).toHaveCount(5, { timeout: 30_000 })

    // The person scrolls the mosaic sideways, to its end, where the last column stands whole.
    const mosaic = valle.locator('[data-valle-mosaic]')
    const scrollLeft = async (): Promise<number> =>
      (await valle.evaluate(
        "Math.round(document.querySelector('[data-valle-mosaic]').scrollLeft)"
      )) as number
    await mosaic.hover()
    await valle.mouse.wheel(4000, 0)
    await expect.poll(scrollLeft, { timeout: 10_000 }).toBeGreaterThan(0)
    // The wheel scrolls smoothly: wait until the mosaic stands still.
    let scrolled = -1
    await expect
      .poll(
        async () => {
          const now = await scrollLeft()
          const still = now === scrolled
          scrolled = now
          return still
        },
        { timeout: 10_000, intervals: [250] }
      )
      .toBe(true)

    // ⤢ on the last column: the dive into that mine, the Work front on it once the run settles.
    const last = mines[4]!
    await valle.locator(`[data-valle-column="${last}"] button.dm-vz__dive`).click()
    await expect(root).toHaveAttribute('data-preset', 'front')
    await valleSettled(valle)
    await expect(valle.locator(`[data-valle-front-mine="${last}"]`)).toHaveCount(1)

    // "Control room" climbs out: the mosaic at the scroll it had before the dive.
    await valle.getByRole('tab', { name: 'Control room' }).click()
    await expect(root).toHaveAttribute('data-preset', 'control')
    await valleSettled(valle)
    await expect.poll(scrollLeft, { timeout: 10_000 }).toBe(scrolled)
  })
})
