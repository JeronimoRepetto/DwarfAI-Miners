import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
  hostSection,
  launchClaude,
  stubOnlyPath
} from '../cut-3a/claudeStreamWorld.ts'

/**
 * L9 (ISSUE-289; 07 machine 23; UC-047; US-VETA-004.AC02, AC03; 17 §1.9): in the E2E build profile, whose built-modes
 * list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), two mines each with a stub Claude dwarf at
 * work show two chambers. Hovering one raises its tab, and only its tab, with the Veta window's bounds exactly as they
 * were: the window holds the band the tab rises into for good (07 §24 I-22). Keyboard focus raises the other one's tab
 * the same way, and "▢" on it moves to the Panel on that mine.
 *
 * The mines are declared the way the Mines page declares one (A-N `declareMine`), the OS folder picker answered in the
 * main process; the launches are the renderer's own `window.api` members (the 3a world). The page's own scripts are
 * strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 300_000 })

/** The Veta window's page, once UI main shows it. */
async function showVeta(app: ElectronApplication, panel: Page): Promise<Page> {
  const moved = (await panel.evaluate("window.api.moveToMode({ mode: 'veta' })")) as {
    ok: boolean
  }
  expect(moved.ok, 'the build lists Veta: build it with DWARFAI_BUILD_PROFILE=e2e').toBe(true)
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes('mode=veta'))
        return page !== undefined
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await page!.waitForSelector('[data-veta-root]')
  return page!
}

/** Declares `folder` as a mine, the OS folder picker answered in the main process, and answers its id. */
async function declareMine(app: ElectronApplication, panel: Page, folder: string): Promise<string> {
  await app.evaluate(({ dialog }, picked) => {
    ;(dialog as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [picked] })
  }, folder)
  const declared = (await panel.evaluate('window.api.declareMine()')) as {
    outcome?: string
    mineId?: string
  }
  expect(declared.outcome, 'declareMine adds the folder: ' + JSON.stringify(declared)).toBe('added')
  const mineId = declared.mineId!
  await expect
    .poll(
      async () => {
        const mines = (
          await hostSection<Array<{ id: string; state: string }>>(panel, 'mines')
        ).flat()
        return mines.find((m) => m.id === mineId)?.state ?? JSON.stringify(mines)
      },
      { timeout: 60_000, message: 'the Host holds the declared mine, enterable' }
    )
    .toMatch(/^(measuring|active)$/)
  return mineId
}

/** The Veta window's bounds, read in the main process. */
async function vetaBounds(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('mode=veta'))
      ?.getBounds()
  )
}

/** The mines whose tab is risen. */
const risen = (veta: Page): Promise<string[]> =>
  veta.evaluate(
    `[...document.querySelectorAll('[data-veta-tab][data-risen="true"]')].map((t) => t.closest('[data-veta-chamber]').dataset.mineId)`
  ) as Promise<string[]>

test.describe('the Veta mine tab (ISSUE-289)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-004.AC02, US-VETA-004.AC03] hover or focus raises one tab with the window bounds unchanged, and Open moves to the Panel on that mine', async () => {
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
    for (const name of ['moria', 'local-issue-classifier']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      const mineId = await declareMine(app, window, folder)
      await launchClaude(window, mineId)
      mines.push(mineId)
    }
    const [moria, classifier] = mines as [string, string]

    const veta = await showVeta(app, window)
    await expect(veta.locator('[data-veta-chamber]')).toHaveCount(2, { timeout: 60_000 })
    // The band is in the window before anything is hovered (taller than the 52 px island): never grown for a hover.
    await expect
      .poll(async () => ((await vetaBounds(app)) as { height?: number } | undefined)?.height ?? 0, {
        timeout: 15_000
      })
      .toBeGreaterThan(52)
    const before = await vetaBounds(app)
    expect(await risen(veta)).toEqual([])

    // Hover: that chamber's tab rises, alone, and the window does not move or grow.
    await veta.locator(`[data-veta-chamber][data-mine-id="${moria}"]`).hover()
    await expect.poll(() => risen(veta)).toEqual([moria])
    await expect(
      veta.locator(`[data-veta-chamber][data-mine-id="${moria}"] [data-tab-name]`)
    ).toBeVisible()
    expect(await vetaBounds(app)).toEqual(before)

    // The pointer away, keyboard focus on the other chamber: its tab rises instead.
    await veta.mouse.move(0, 0)
    await veta.locator(`[data-veta-chamber][data-mine-id="${classifier}"]`).focus()
    await expect.poll(() => risen(veta)).toEqual([classifier])
    expect(await vetaBounds(app)).toEqual(before)

    // "▢" on it: the Panel opens on that mine (A-N13).
    await veta
      .locator(`[data-veta-chamber][data-mine-id="${classifier}"] [data-tab-open]`)
      .press('Enter')
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((w) => !w.isDestroyed() && w.isVisible())
              .map((w) => (w.webContents.getURL().includes('mode=veta') ? 'veta' : 'panel'))
          ),
        { timeout: 15_000 }
      )
      .toEqual(['panel'])
  })
})
