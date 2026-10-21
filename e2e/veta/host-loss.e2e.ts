import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  anyWindowVisible,
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  profileHostPid,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { createClaudeStreamWorld, launchClaude, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { hostConnectionOf, killHost, shownModes } from '../support/hostLoss.ts'
import { declareMine, showVeta } from '../support/veta.ts'
import { namesOf, recordVetaMotion, vetaMoments } from '../support/vetaMotionLog.ts'

/**
 * L9 (ISSUE-296; UC-067; ADR-002 D9; ADR-033 item 3; 07 S20.15, S20.16, S26.15, 12B; 13 CH-01; 17 §1.10): in the E2E
 * build profile, whose built-modes list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), Veta shows
 * one stub Claude dwarf and the Host is killed for real (CH-01), three times within five minutes. Throughout, the strip
 * holds what it last knew, read-only (`data-held`), and nothing walks; on the third kill the crash-loop message shows
 * in the Veta window with its Retry and the mode stays Veta; Retry respawns the Host, the message goes, and the snapshot
 * read after it is applied with no walk-out and no walk-in. What a missing dwarf and its risen chat do on that snapshot
 * is proven at L2 (`useVetaLife.test.ts`, `useVetaRisen.test.ts`): no fixture world loses a dwarf while the Host is
 * down without writing the Host's database, which the harness never does (17 §1.9).
 *
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 300_000 })

test.describe('Veta through a Host loss (ISSUE-296)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[CH-01, ADR-002, ADR-033] killing the Host while Veta is shown holds the strip and, after the respawn, re-snapshots with no walk-out', async () => {
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

    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    const { dwarfId } = await launchClaude(window, mineId)

    const veta = await showVeta(app, window)
    const root = veta.locator('[data-veta-root]')
    const dwarf = veta.locator(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    await expect(dwarf).not.toHaveAttribute('data-walk', /.+/, { timeout: 15_000 })
    await expect(root).not.toHaveAttribute('data-held', /.+/)
    await recordVetaMotion(veta)

    // CH-01, three times within five minutes: every time the strip is held as last known, with no walk.
    for (const kill of [1, 2, 3]) {
      await killHost(owned, kill === 3)
      await expect(dwarf, `kill ${kill}: the dwarf stays drawn`).toBeVisible()
      await expect(veta.locator('[data-veta-chamber]')).toHaveCount(1)
    }
    await expect(root).toHaveAttribute('data-held', 'true', { timeout: 30_000 })
    await veta.screenshot({ path: test.info().outputPath('veta-held.png') })

    // The crash loop: ONE message, in the Veta window, with its Retry; nothing respawns and the mode stays Veta.
    const message = veta.locator('.dm-host-state')
    await expect(message).toHaveCount(1, { timeout: 30_000 })
    await expect(message).toHaveAttribute('data-variant', 'crash-loop')
    expect(await hostConnectionOf(veta)).toEqual({ state: 'unavailable', reason: 'crash-loop' })
    const left = profileHostPid(owned.userDataDir)
    expect(left === null || !isProcessAlive(left), 'nothing respawns in a crash loop').toBe(true)
    expect(await shownModes(app)).toEqual(['veta'])
    await expect(dwarf).toBeVisible()
    const retry = veta.getByRole('dialog').filter({ has: message }).getByRole('button')
    // Reachable by keyboard: the dialog hands its one action the focus.
    await expect(retry).toBeFocused()
    await veta.screenshot({ path: test.info().outputPath('veta-host-state.png') })

    // Retry (A-N05): the Host is started again and reached; the message goes; the strip follows the new snapshot.
    await retry.click()
    await waitForHostAttached(owned)
    await expect
      .poll(async () => (await hostConnectionOf(veta)).state, { timeout: 60_000 })
      .toBe('connected')
    await expect(message).toHaveCount(0, { timeout: 30_000 })
    await expect(root).not.toHaveAttribute('data-held', /.+/, { timeout: 30_000 })
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    expect(await shownModes(app)).toEqual(['veta'])
    await veta.screenshot({ path: test.info().outputPath('veta-resnapshot.png') })

    // Nothing walked through the loss or after it: no walk-out, no walk-in, no chamber closed or opened.
    const moments = await vetaMoments(veta)
    expect(namesOf(moments, ['walk:', '-chamber', '+chamber', '-dwarf'])).toEqual([])
  })
})
