import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  chooseTrayItem,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { showValle, valleSettled } from '../support/valle.ts'

/**
 * L9 (ISSUE-305; US-VALLE-005.AC01, .AC02, .AC04, .AC05, .AC06; 07 machine 33; UC-057): in the E2E build profile (Valle in
 * its built-modes list, docs/e2e.md), the 12 px splitter in the Control room sizes the laid-out chat zone: 440 px by
 * default, a drag follows the pointer and the release is stored for that preset, End leaves the mines their 248 px,
 * and a double click puts the default back, its stored width cleared. Each width is read from the layout itself and
 * from the separator's `aria-valuenow`, which must agree (TC-305-01).
 */

test.describe.configure({ timeout: 180_000 })

/** UI main's Valle layout store (`JsonUiPreferenceStore`, ISSUE-299). */
const LAYOUT_FILE = 'valle-layout-v1.json'

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** A laid-out width, in whole px. */
async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'laid out').not.toBeNull()
  return Math.round(box!.width)
}

async function ariaNumber(bar: Locator, name: string): Promise<number> {
  return Number(await bar.getAttribute(name))
}

/** The chat zone's laid-out width agrees with the separator's value. */
async function expectChatWidth(valle: Page, bar: Locator, width: number): Promise<void> {
  await expect(bar).toHaveAttribute('aria-valuenow', String(width))
  await expect.poll(() => widthOf(valle.locator('.dm-valle__chats'))).toBe(width)
}

test.describe('the Valle splitter (ISSUE-305)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
  })

  test('[US-VALLE-005.AC01, US-VALLE-005.AC02, US-VALLE-005.AC04, US-VALLE-005.AC05, US-VALLE-005.AC06] a person drags, keys and resets the chat zone in the Control room', async () => {
    launched = await launchApp({ trayProbe: true, tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    const valle = await showValle(app, window)
    await valleSettled(valle)
    const layoutFile = path.join(profile.userDataDir, LAYOUT_FILE)

    const bar = valle.getByRole('separator', { name: 'Resize the chats' })
    await expect(bar).toHaveAttribute('aria-valuemin', '340')
    // The Control room's default.
    await expectChatWidth(valle, bar, 440)

    // A drag 100 px to the left widens the chat zone by as much; the release stores it for the Control room.
    const box = (await bar.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await valle.mouse.move(x, y)
    await valle.mouse.down()
    await valle.mouse.move(x - 60, y)
    await valle.mouse.move(x - 100, y)
    await expectChatWidth(valle, bar, 540)
    await valle.mouse.up()
    await expect
      .poll(() => readJson(layoutFile), { timeout: 10_000 })
      .toMatchObject({ control: { chatWidth: 540 } })

    // End: the maximum, which leaves the mines their 248 px.
    await bar.focus()
    await valle.keyboard.press('End')
    const max = await ariaNumber(bar, 'aria-valuemax')
    await expectChatWidth(valle, bar, max)
    // The body's width may be fractional; the chat zone's is whole, so the mines keep 248 px within a pixel.
    const mines = (await valle.locator('.dm-valle__main').boundingBox())!.width
    expect(Math.abs(mines - 248)).toBeLessThanOrEqual(1)
    await expect
      .poll(() => readJson(layoutFile), { timeout: 10_000 })
      .toMatchObject({ control: { chatWidth: max } })

    // A double click: the default again, the stored width cleared; the Work front's untouched.
    await bar.dblclick()
    await expectChatWidth(valle, bar, 440)
    await expect
      .poll(() => readJson(layoutFile), { timeout: 10_000 })
      .toMatchObject({ control: { chatWidth: 0 }, front: { chatWidth: 0 } })
  })
})
