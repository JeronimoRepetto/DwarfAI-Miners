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
import { showValle, valleAudioMuted, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/vetaScene.ts'

/**
 * L9 (ISSUE-307; US-VALLE-013.AC02, .AC03, .AC05, .AC06, .AC09; 07 machine 35; UC-060): in the E2E build profile (Valle
 * in its built-modes list, docs/e2e.md), the Control room marks one current mine, the first column while nothing was
 * picked; a single click on another column's painting moves the mark there, a dive makes the Work front's mine current,
 * and the climb out keeps it. The mark is read from the accessibility attributes (`aria-current`, ", current" in the
 * zone's name). Every page is muted in the main process (`showValle`), so the current mine's room tone is never heard;
 * the case checks the Valle page is muted. The mosaic order is written the way UI main keeps it while the app is closed,
 * as `dive.e2e.ts` does.
 */

test.describe.configure({ timeout: 300_000 })

/** UI main's mosaic order file (`JsonUiPreferenceStore`, ISSUE-299). */
const ORDER_FILE = 'valle-mosaic-order-v1.json'

test.describe('the current mine in Valle (ISSUE-307)', () => {
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

  test('[US-VALLE-013.AC02, US-VALLE-013.AC03, US-VALLE-013.AC06, US-VALLE-013.AC09] one mine is current: the first column, then a clicked painting, then the mine dived into', async () => {
    profile = createIsolatedProfile()
    const first = await relaunch()
    await chooseTrayItem(first.app, TRAY_ITEMS.open)
    await answerFirstRunStep(first.window)
    const mines: string[] = []
    for (const name of ['mine-a', 'mine-b']) {
      const folder = path.join(profile.root, name)
      mkdirSync(folder)
      mines.push(await declareMine(first.app, first.window, folder))
    }
    await launched!.teardown()
    launched = undefined
    writeFileSync(path.join(profile.userDataDir, ORDER_FILE), JSON.stringify({ order: mines }))

    const second = await relaunch()
    await chooseTrayItem(second.app, TRAY_ITEMS.open)
    const valle = await showValle(second.app, second.window)
    await valleSettled(valle)
    expect(await valleAudioMuted(second.app)).toBe(true)
    await expect(valle.locator('[data-valle-column]')).toHaveCount(2, { timeout: 30_000 })
    const [a, b] = [mines[0]!, mines[1]!]
    const current = valle.locator('[data-valle-zone][aria-current="true"]')

    // Nothing picked: the first column is current (S35.06), one mark only.
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-valle-column', a)
    await expect(current).toHaveAttribute('aria-label', 'Mine mine-a, current')

    // A single click on the other column's painting moves the mark (S35.02).
    await valle.locator(`[data-valle-column="${b}"] .dm-vz__well`).click()
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-valle-column', b)
    await expect(valle.locator(`[data-valle-column="${a}"]`)).toHaveAttribute(
      'aria-label',
      'Mine mine-a'
    )

    // ⤢ on the first column dives in: the Work front's one mine is current (S35.03).
    await valleSettled(valle)
    await valle.locator(`[data-valle-column="${a}"] button.dm-vz__dive`).click()
    await valleSettled(valle)
    await expect(valle.locator(`[data-valle-front-mine="${a}"]`)).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect(valle.locator(`[data-valle-row="${a}"]`)).toHaveAttribute('data-current', 'true')

    // The climb out keeps the mine dived into current while its column stands.
    await valle.getByRole('tab', { name: 'Control room' }).click()
    await valleSettled(valle)
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-valle-column', a)
  })
})
