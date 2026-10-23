import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
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
 * L9 (ISSUE-309; US-VALLE-010.AC01, .AC04, .AC05; 07 machine 37; UC-062): in the E2E build profile (Valle in its built-modes
 * list, docs/e2e.md), the top bar's "⋯" menu holds "Reset preset": after the Control room's chat zone was dragged wider,
 * resetting the Control room puts its chat zone back at 440 px with its stored width
 * cleared, a toast naming it that does not cover the chat zone, and the Work front's own layout untouched in the store.
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

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box, 'laid out').not.toBeNull()
  return box!
}

test.describe('Reset preset (ISSUE-309)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
  })

  test('[US-VALLE-010.AC01, US-VALLE-010.AC04, US-VALLE-010.AC05] a person resets the Control room from the top bar menu: its chat zone back to 440 px, the toast, the Work front untouched', async () => {
    launched = await launchApp({ trayProbe: true, tracePath: test.info().outputPath('trace.zip') })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    const valle = await showValle(app, window)
    await valleSettled(valle)
    const layoutFile = path.join(profile.userDataDir, LAYOUT_FILE)
    const chats = valle.locator('.dm-valle__chats')

    // The Control room's chat zone dragged 100 px wider; the release stores it.
    const bar = valle.getByRole('separator', { name: 'Resize the chats' })
    const grip = await boxOf(bar)
    const x = grip.x + grip.width / 2
    const y = grip.y + grip.height / 2
    await valle.mouse.move(x, y)
    await valle.mouse.down()
    await valle.mouse.move(x - 60, y)
    await valle.mouse.move(x - 100, y)
    await valle.mouse.up()
    await expect.poll(async () => Math.round((await boxOf(chats)).width)).toBe(540)
    await expect
      .poll(() => readJson(layoutFile), { timeout: 10_000 })
      .toMatchObject({ control: { chatWidth: 540 } })
    const front = (readJson(layoutFile) as { front: unknown }).front

    // "⋯" › "Reset preset": the default width, the stored one cleared, and the toast naming the preset.
    await valle.getByRole('button', { name: 'Preset options' }).click()
    await valle.getByRole('menuitem', { name: 'Reset preset' }).click()
    await valleSettled(valle)
    await expect.poll(async () => Math.round((await boxOf(chats)).width)).toBe(440)
    await expect
      .poll(() => readJson(layoutFile), { timeout: 10_000 })
      .toMatchObject({ control: { chatWidth: 0 }, front })
    const toast = valle.locator('.dm-toasts').getByText('Control room is back to its preset')
    await expect(toast).toBeVisible()

    // The toast covers neither the chat zone nor the chats' composer. The profile has no mine yet, so no column is drawn:
    // the placement over the mines is the unit case's (the one toast host), and the design's Valle rule is open (07 §24 I-38).
    const shown = await boxOf(toast)
    const apart = (other: { x: number; y: number; width: number; height: number }): boolean =>
      shown.x + shown.width <= other.x ||
      other.x + other.width <= shown.x ||
      shown.y + shown.height <= other.y ||
      other.y + other.height <= shown.y
    expect(apart(await boxOf(chats))).toBe(true)
  })
})
