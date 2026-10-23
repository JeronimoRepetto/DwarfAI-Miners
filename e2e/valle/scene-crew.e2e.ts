import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
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
import { createClaudeStreamWorld, launchClaude, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'
import { openMineColumn } from '../support/vetaScene.ts'

/**
 * L9 (Valle QA VQA-10, the shared scene; `DS` prototype sample-data.js "each station is the one the app's scene gives
 * the dwarf's id"): every dwarf a person launches is a foreman, and a crew of them used to huddle on the one landing of
 * the interior's three foreman diamonds. With five stub Claude dwarfs in one mine, the Panel's mine column and Valle's
 * zone, which share the scene, stand each on a station of its own and spread them over the galleries, at 1024 × 768
 * and at 1600 × 960. VQA-14: a zone showing the map keeps its "· Map" whole beside a long name at 1024 × 768. Each\n * layout is captured to the case's output folder.
 */

test.describe.configure({ timeout: 300_000 })

const CREW = 5

/**
 * Where a capture goes: the case's output folder, or `DWARFAI_E2E_SHOTS_DIR` when set, so a passing run's pictures
 * outlive Playwright's output clean-up.
 */
function shotPath(name: string): string {
  const dir = process.env.DWARFAI_E2E_SHOTS_DIR
  return dir === undefined || dir === '' ? test.info().outputPath(name) : path.join(dir, name)
}
const SIZES = [
  { width: 1024, height: 768 },
  { width: 1600, height: 960 }
] as const

/** Resizes the window whose URL matches `mode` (none for the Panel) to a content size. */
async function resize(
  app: ElectronApplication,
  mode: string | null,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, screen }, { mode, size }) => {
      const window = BrowserWindow.getAllWindows().find((w) => {
        const url = w.webContents.getURL()
        return mode === null ? !url.includes('mode=') : url.includes(`mode=${mode}`)
      })!
      const area = screen.getDisplayMatching(window.getBounds()).workArea
      window.setContentBounds({ x: area.x, y: area.y, ...size })
    },
    { mode, size }
  )
}

/** The centre of each sprite in `art`, once two readings 400 ms apart agree (any walk-in has ended). */
async function settledCentres(page: Page, art: Locator): Promise<Array<{ x: number; y: number }>> {
  const read = async () => {
    const centres: Array<{ x: number; y: number }> = []
    for (const sprite of await art.locator('button.dm-dwarf[data-dwarf]').all()) {
      const box = await sprite.boundingBox()
      if (box !== null) centres.push({ x: box.x + box.width / 2, y: box.y + box.height })
    }
    return centres
  }
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await read())
        const same = now === last
        last = now
        await page.waitForTimeout(400)
        return same
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return JSON.parse(last) as Array<{ x: number; y: number }>
}

/** One reading of a crew: its sprites' centres and the art's height, in CSS px. */
interface CrewReading {
  readonly where: string
  readonly centres: ReadonlyArray<{ x: number; y: number }>
  readonly artHeight: number
}

async function readCrew(page: Page, art: Locator, where: string): Promise<CrewReading> {
  const centres = await settledCentres(page, art)
  return { where, centres, artHeight: (await art.boundingBox())!.height }
}

/** Every pair of sprites stands apart, and the crew covers more than one landing of the art. */
function expectSpread({ where, centres, artHeight }: CrewReading): void {
  expect(centres, where).toHaveLength(CREW)
  for (const [i, a] of centres.entries()) {
    for (const b of centres.slice(i + 1)) {
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${where}: two sprites on one spot`).toBeGreaterThan(
        8
      )
    }
  }
  const ys = centres.map((c) => c.y)
  // The three foreman diamonds span under 5% of the painting's height.
  expect((Math.max(...ys) - Math.min(...ys)) / artHeight, `${where}: one landing`).toBeGreaterThan(
    0.15
  )
}

test.describe('the crew spread over the mine (VQA-10)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-MINE-009.AC01] five foremen in one mine stand on stations of their own, in the Panel column and in Valle', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    // A name longer than a zone's header at 1024 px, so the header has to give way (VQA-14).
    const folder = path.join(owned.root, 'karak-eight-peaks-ledger')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    for (let n = 0; n < CREW; n++) await launchClaude(window, mineId)

    // Each layout is captured first and held to the spread at the end, so a failing run still leaves its pictures.
    const readings: CrewReading[] = []

    // The Panel's mine column.
    await openMineColumn(window)
    const column = window.locator('.shell-mine .dm-minecol__art')
    await expect(column.locator('button.dm-dwarf[data-dwarf]')).toHaveCount(CREW, {
      timeout: 60_000
    })
    for (const size of SIZES) {
      await resize(app, null, size)
      readings.push(await readCrew(window, column, `Panel ${size.width}x${size.height}`))
      await window.screenshot({
        path: shotPath(`panel-column-${size.width}x${size.height}.png`)
      })
    }

    // Valle's zone for the same mine.
    const valle = await showValle(app, window)
    await valleSettled(valle)
    const zone = valle.locator(`[data-valle-art="${mineId}"]`)
    await expect(zone.locator('button.dm-dwarf[data-dwarf]')).toHaveCount(CREW, { timeout: 30_000 })
    for (const size of SIZES) {
      await resize(app, 'valle', size)
      await valleSettled(valle)
      readings.push(await readCrew(valle, zone, `Valle ${size.width}x${size.height}`))
      await valle.screenshot({
        path: shotPath(`valle-${size.width}x${size.height}.png`)
      })
    }

    // VQA-14: the zone showing the map, at 1024 × 768, its long name giving way so "· Map" stays whole.
    await resize(app, 'valle', SIZES[0])
    await valleSettled(valle)
    const header = valle.locator(`[data-valle-column="${mineId}"]`)
    await header.locator('[data-zone-more]').click()
    await valle.getByRole('menuitem', { name: /^Show here: the map/ }).click()
    await valleSettled(valle)
    const suffix = header.locator('[data-zone-suffix]')
    await expect(suffix).toHaveText('· Map')
    await valle.screenshot({ path: shotPath('valle-header-map-1024x768.png') })
    const suffixBox = (await suffix.boundingBox())!
    const titleBox = (await header.locator('.dm-vz__title').boundingBox())!

    for (const reading of readings) expectSpread(reading)
    expect(suffixBox.x + suffixBox.width, '"· Map" runs past the title').toBeLessThanOrEqual(
      titleBox.x + titleBox.width + 1
    )
  })
})
