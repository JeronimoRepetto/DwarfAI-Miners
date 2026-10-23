import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
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

/**
 * L9 (owner ruling 2026-10-23, VQA-07; US-VALLE-006.AC08; 07 S32.01 as the ruling reads it): Valle is opened before any
 * mine exists, so the Control room is empty and its order was never arranged by the person. A mine is then declared and
 * a stub Claude dwarf launched in it: the mine joins the Control room by itself, and the Work front tab takes the
 * person into it. Stub CLIs only; no OS dialog (the mine is declared through the harness, not the folder picker).
 */

test.describe.configure({ timeout: 300_000 })

test.describe("Valle's first visit with no mine (owner ruling 2026-10-23)", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-006.AC08, S32.01] a mine with a crew added after Valle opened empty joins the Control room, and the Work front tab enters it', async () => {
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

    // Valle first, with no mine at all.
    const valle = await showValle(app, window)
    await valleSettled(valle)
    const root = valle.locator('[data-valle-root]')
    await expect(root).toHaveAttribute('data-motion', 'none')
    const columns = valle.locator('.dm-valle__body [data-valle-column]:not(.dm-vghosts *)')
    await expect(columns).toHaveCount(0)

    // A mine, then its first dwarf.
    const folder = path.join(owned.root, 'alpha')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    await launchClaude(window, mineId)

    // It joins the Control room by itself.
    await expect(
      valle.locator(`.dm-valle__body [data-valle-column="${mineId}"]:not(.dm-vghosts *)`)
    ).toHaveCount(1, { timeout: 30_000 })

    // The Work front tab enters it.
    await valle.getByRole('tab', { name: 'Work front' }).click()
    await expect(root).toHaveAttribute('data-preset', 'front', { timeout: 15_000 })
    await expect(root).toHaveAttribute('data-motion', 'none', { timeout: 15_000 })
  })
})
