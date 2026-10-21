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
  ASK_MARKER,
  asksOf,
  createClaudeStreamWorld,
  dwarfsOf,
  hostSection,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'

/**
 * L9 (ISSUE-287; 07 machine 20; US-VETA-001.AC01, AC03; 17 §1.9): in the E2E build profile, whose built-modes list
 * contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), Veta follows a real stub session through the
 * Host: a mine with no dwarf shows the closed entrance, the Claude stub's dwarf at work (asking for a permission, so
 * the state holds while the case looks) shows "Sessions working" with its chamber lit, and the session's end brings the
 * closed entrance back.
 *
 * The mine is declared the way the Mines page declares one (A-N `declareMine`), with the OS folder picker answered in
 * the main process, so no session but the stub's is ever in it. The launch, the message, the answer and the stop are
 * the renderer's own `window.api` members (the 3a world, `../cut-3a/claudeStreamWorld.ts`); the UI that makes them has
 * its own tests. The page's own scripts are strings: the e2e project has no DOM types.
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

/** The life state the Veta root draws (`data-life`). */
const lifeOf = (veta: Page): Promise<string | null> =>
  veta.evaluate(
    "document.querySelector('[data-veta-root]')?.getAttribute('data-life') ?? null"
  ) as Promise<string | null>

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
  let mines: Array<{ id: string; state: string }> = []
  await expect
    .poll(
      async () => {
        mines = (await hostSection<Array<{ id: string; state: string }>>(panel, 'mines')).flat()
        return mines.find((m) => m.id === mineId)?.state ?? JSON.stringify(mines)
      },
      { timeout: 60_000, message: 'the Host holds the declared mine, enterable' }
    )
    .toMatch(/^(measuring|active)$/)
  return mineId
}

test.describe('Veta life states (ISSUE-287)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VETA-001.AC01, US-VETA-001.AC03] a working stub session shows sessions working and its end shows the closed entrance', async () => {
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

    // A known mine with no dwarf: the closed entrance, the one click target.
    const veta = await showVeta(app, window)
    await expect.poll(() => lifeOf(veta), { timeout: 15_000 }).toBe('no-sessions')
    await expect(veta.locator('[data-veta-entrance]')).toBeVisible()
    await expect(veta.locator('[data-veta-chamber]')).toHaveCount(0)

    // The stub's dwarf at work, asking for its Write tool: sessions working, its chamber lit.
    const { dwarfId } = await launchClaude(window, mineId)
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId,
        text: `Please write the ${ASK_MARKER}.`,
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true })
    await expect.poll(() => lifeOf(veta), { timeout: 60_000 }).toBe('sessions-working')
    const chamber = veta.locator(`[data-veta-chamber][data-mine-id="${mineId}"]`)
    await expect(chamber).toHaveAttribute('data-attention', 'true')
    await expect(chamber.locator(`[data-dwarf-id="${dwarfId}"] [data-veta-ask]`)).toHaveText('?')
    await expect(veta.locator('[data-veta-entrance]')).toHaveCount(0)

    // The person allows it; the turn ends and the dwarf rests.
    const askId = (await asksOf(window)).find(
      (a) => a.dwarfId === dwarfId && a.state === 'open'
    )?.id
    expect(askId, 'the stub’s permission request is open').toBeDefined()
    await window.evaluate(
      `window.api.answerDwarfPermission(${JSON.stringify({
        askId,
        decision: 'allow',
        requestId: uuidv7()
      })})`
    )
    await expect.poll(() => lifeOf(veta), { timeout: 60_000 }).toBe('all-idle')

    // The session ends: the dwarf leaves and the strip contracts to the closed entrance.
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
    await expect.poll(() => lifeOf(veta), { timeout: 30_000 }).toBe('no-sessions')
    await expect(veta.locator('[data-veta-entrance]')).toBeVisible()
    await expect(veta.locator('[data-veta-chamber]')).toHaveCount(0)
  })
})
