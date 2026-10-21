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
import {
  createClaudeStreamWorld,
  dwarfsOf,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { declareMine, showVeta, vetaBounds } from '../support/veta.ts'
import { namesOf, recordVetaMotion, vetaMoments } from '../support/vetaMotionLog.ts'

/**
 * L9 (ISSUE-292; 07 machine 26; UC-050; US-VETA-007.AC01, AC04, US-VETA-008.AC01, AC03; 17 §1.9): in the E2E build
 * profile, whose built-modes list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a stub Claude
 * session arrives while Veta shows "No sessions" and later ends. The page records what it shows and moves as it
 * happens (`../support/vetaMotionLog.ts`): the entrance lamp lights, the island is built, and only then does the dwarf
 * walk in; at the end it walks out, its chamber closes and the strip contracts to the closed entrance. The window's
 * anchor corner never moves.
 *
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 300_000 })

test.describe('Veta arrival and departure choreography (ISSUE-292)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-007.AC01, US-VETA-007.AC04, US-VETA-008.AC01, US-VETA-008.AC03, S26.01, S26.10] a first session lights the lamp, builds the island and walks in; its end walks out and contracts the strip, the anchor corner fixed', async () => {
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

    const veta = await showVeta(app, window)
    await expect(veta.locator('[data-veta-entrance]')).toBeVisible()
    const closed = await vetaBounds(app)
    await recordVetaMotion(veta)

    // The first session arrives while Veta shows "No sessions".
    const { dwarfId } = await launchClaude(window, mineId)
    const dwarf = veta.locator(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    await expect(dwarf).not.toHaveAttribute('data-walk', /.+/)
    await expect(veta.locator('[data-veta-entrance]')).toHaveCount(0)
    const arrived = await vetaMoments(veta)
    // The lamp lit first; the island built at its final size; only then did the dwarf walk in, then settle.
    expect(namesOf(arrived, ['lamp:', '-entrance', '+dwarf', 'walk:'])).toEqual([
      'lamp:lit',
      '-entrance',
      '+dwarf:waiting',
      'walk:in',
      'walk:none'
    ])
    const open = await vetaBounds(app)
    // The anchor corner (the bottom-right one, by default) never moved; the island grew away from it.
    expect(open.x + open.width).toBe(closed.x + closed.width)
    expect(open.y + open.height).toBe(closed.y + closed.height)
    expect(open.width).toBeGreaterThan(closed.width)

    // The session ends: the dwarf walks out, the chamber closes, the strip contracts to the closed entrance.
    const stopped = await window.evaluate(
      `window.api.stopDwarf(${JSON.stringify({ dwarfId, requestId: uuidv7() })})`
    )
    expect(stopped, 'A-N29 ends the session').toMatchObject({ ok: true })
    await expect
      .poll(
        async () =>
          (await dwarfsOf(window)).some((d) => d.id === dwarfId && d.presence !== 'walking-out'),
        { timeout: 30_000, message: 'the dwarf left' }
      )
      .toBe(false)
    await expect(veta.locator('[data-veta-entrance]')).toBeVisible({ timeout: 15_000 })
    await expect(veta.locator('[data-veta-chamber]')).toHaveCount(0)
    const left = (await vetaMoments(veta)).slice(arrived.length)
    expect(namesOf(left, ['walk:out', '-dwarf', '-chamber', '+entrance'])).toEqual([
      'walk:out',
      '-chamber',
      '+entrance'
    ])
    // The window shrank back once the motion ended, the anchor corner where it was.
    await expect
      .poll(async () => (await vetaBounds(app)).width, { timeout: 15_000 })
      .toBe(closed.width)
    const after = await vetaBounds(app)
    expect(after.x + after.width).toBe(closed.x + closed.width)
    expect(after.y + after.height).toBe(closed.y + closed.height)
  })
})
