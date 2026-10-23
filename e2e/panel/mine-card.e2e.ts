import { mkdirSync, writeFileSync } from 'node:fs'
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
import { hostSection } from '../cut-3a/claudeStreamWorld.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (US-MINES-008, US-MINE-010; 17 §1.9): the Panel's mine card draws what the Host measured. A declared mine whose
 * folder holds 400 KB of source (two distinct files, each under the walk's bundle ceiling) is measured by the Host;
 * its `MineWire` carries the score (AMENDMENT-26, owner-approved 2026-10-23) and its ore (`totals`), and the card on the
 * Mines page shows the progress row toward the next tier under the Host's default thresholds (Copper from 350 KB,
 * Silver from 1 500 KB) and its ore row. No provider runs: the stub kit's turns earn a few tokens, under one unit of
 * any material, so the ore capsules themselves are proven at L3 (`useMinesPage.host.test.ts`), fed Host-shaped frames.
 * No dialog shows: the folder picker is answered in the main process.
 */

test.describe.configure({ timeout: 240_000 })

test.describe("the Panel's mine card over the Host's measurement", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-MINES-008.AC01, US-MINE-010.AC04] a measured mine card shows its ore row and its progress toward the next tier from the Host score', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const folder = path.join(owned.root, 'deep-seam')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'main.ts'), 'x'.repeat(200 * 1024))
    writeFileSync(path.join(folder, 'lode.ts'), 'y'.repeat(200 * 1024))
    const mineId = await declareMine(app, window, folder)

    // The Host measured it and carries the score on its MineWire.
    await expect
      .poll(
        async () => {
          const mines = (
            await hostSection<
              Array<{ id: string; state: string; tier: string | null; score?: unknown }>
            >(window, 'mines')
          ).flat()
          const mine = mines.find((m) => m.id === mineId)
          return mine === undefined ? 'absent' : { tier: mine.tier, score: mine.score }
        },
        { timeout: 60_000, message: 'the Host measured the declared mine' }
      )
      .toEqual({ tier: 'copper', score: { kb: 400, nextTierKb: 1500 } })

    await window.locator('.dm-nav .dm-slot[data-label="Mines"]').click()
    const card = window.locator(`.dm-card[data-mine="${mineId}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    // Its ore row is drawn, with no capsule for a material it holds none of.
    await expect(card.locator('.dm-card__ore')).toBeAttached()
    await expect(card.locator('.dm-card__ore .dm-ore')).toHaveCount(0)
    const progress = card.locator('.dm-card__progress')
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await expect(progress.locator('.dm-progress__row')).toHaveText(/Next:\s*Silver\s*400 \/ 1,500/)
    const bar = progress.locator('[role="progressbar"]')
    await expect(bar).toHaveAttribute('aria-valuenow', '400')
    await expect(bar).toHaveAttribute('aria-valuemax', '1500')
  })
})
