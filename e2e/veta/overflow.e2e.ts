import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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
  ASK_MARKER,
  CLAUDE,
  createClaudeStreamWorld,
  dwarfsOf,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { declareMine, risenContent, showVeta, vetaBounds } from '../support/veta.ts'

/**
 * L9 (ISSUE-291; 07 machine 25; UC-049; US-VETA-006.AC01, AC02, AC06, AC08, AC09; NFR-A11Y-15; 17 §1.9, §1.12): in the
 * E2E build profile, whose built-modes list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), six
 * mines each with a stub Claude dwarf at work. As many chambers as fit the screen's edge show, at most four, and the
 * rest fold into "+N"; the last mine's dwarf asks, so "+N" carries the needs-you signal. Tab walks the strip and never
 * stops on "+N" (the accepted mouse-only gap, pinned here so it cannot change silently). Hovering "+N" lists the
 * folded mines with the window bounds unchanged, and a click on the asking mine unfolds its chamber and raises the
 * chat of the dwarf that needs the person.
 *
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 420_000 })

/** Launches a stub Claude dwarf whose first turn asks for a tool, and waits until it needs the person. */
async function launchAsking(window: Page, mineId: string): Promise<string> {
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = (await window.evaluate(
    `window.api.launchAgent(${JSON.stringify({
      mineId,
      way: { kind: 'supplier', providerId: CLAUDE },
      prompt: `Write the ${ASK_MARKER}.`,
      jevOn: false,
      jevAutoAccept: false,
      requestId: uuidv7()
    })})`
  )) as { ok: boolean }
  expect(accepted, 'A-35 accepts the asking launch').toMatchObject({ ok: true })
  let dwarfId: string | undefined
  await expect
    .poll(
      async () => {
        const dwarf = (await dwarfsOf(window)).find((d) => d.mineId === mineId && !before.has(d.id))
        dwarfId = dwarf?.id
        return dwarf?.status ?? 'not arrived'
      },
      { timeout: 90_000, message: 'the launched dwarf asks for its tool' }
    )
    .toBe('asking')
  return dwarfId!
}

/** The mine ids of the drawn chambers. */
const drawn = (veta: Page): Promise<string[]> =>
  veta.evaluate(
    `[...document.querySelectorAll('[data-veta-chamber]')].map((c) => c.dataset.mineId)`
  ) as Promise<string[]>

test.describe('the Veta overflow "+N" (ISSUE-291)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-006.AC01, US-VETA-006.AC06, US-VETA-006.AC08, US-VETA-006.AC09, NFR-A11Y-15] six mines fold into +N, Tab never reaches it, and a click on its asking mine unfolds it and opens that chat', async () => {
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

    const mines: string[] = []
    for (const name of ['moria', 'erebor', 'khazad', 'ironhills', 'belegost', 'nogrod']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      mines.push(await declareMine(app, window, folder))
    }
    for (const mineId of mines.slice(0, 5)) await launchClaude(window, mineId)
    const nogrod = mines[5]!
    const asking = await launchAsking(window, nogrod)

    const veta = await showVeta(app, window)
    const more = veta.locator('[data-veta-more]')
    await expect(more).toBeVisible({ timeout: 60_000 })
    const shown = await drawn(veta)
    // As many as fit, at most four, at least one; the rest are counted by "+N".
    expect(shown.length).toBeGreaterThanOrEqual(1)
    expect(shown.length).toBeLessThanOrEqual(4)
    await expect(more).toHaveText(`+${6 - shown.length}`)
    expect(shown).not.toContain(nogrod)
    // The folded mine's dwarf needs the person: "+N" shows the needs-you signal (OQ-76 A).
    await expect(more).toHaveAttribute('data-attention', 'true')

    // Tab from the strip's first part to its last never stops on "+N" (PO #55).
    const parts = await veta.evaluate(
      `[...document.querySelectorAll('[data-veta-island] button, [data-veta-island] [tabindex]')].filter((el) => el.tabIndex >= 0).length`
    )
    await veta.locator('[data-veta-island] [data-veta-part]').first().focus()
    const visited: string[] = []
    for (let step = 0; step < (parts as number) + 2; step += 1) {
      visited.push(
        (await veta.evaluate(
          `(() => { const at = document.activeElement; return at?.closest('[data-veta-more-slot]') ? 'more' : at?.closest('[data-veta-island]') ? 'island' : 'out' })()`
        )) as string
      )
      await veta.keyboard.press('Tab')
    }
    expect(visited).toContain('island')
    expect(visited).not.toContain('more')

    // Hovering "+N" lists the folded mines; its room was held beforehand, so the window keeps its bounds.
    const before = await vetaBounds(app)
    await veta.locator('[data-veta-more-slot]').hover()
    const list = veta.locator('[data-veta-more-list]')
    await expect(list).toHaveAttribute('data-shown', 'true')
    await expect(list.locator('[data-veta-more-item]')).toHaveCount(6 - shown.length)
    expect(await vetaBounds(app)).toEqual(before)

    // A click on the asking mine's item: its chamber unfolds and the chat of its asking dwarf rises.
    await list.locator(`[data-veta-more-item][data-mine-id="${nogrod}"]`).click()
    await expect.poll(() => drawn(veta), { timeout: 15_000 }).toContain(nogrod)
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    await expect(veta.locator(`[data-veta-dwarf][data-dwarf-id="${asking}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
