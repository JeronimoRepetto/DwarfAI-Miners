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
import { createClaudeStreamWorld, stubOnlyPath } from '../cut-3a/claudeStreamWorld.ts'
import { muteAppAudio, showValle } from '../support/valle.ts'
import { showVeta } from '../support/veta.ts'

/**
 * L9 (owner ruling 2026-10-24, "one music, one playlist"; AMENDMENT-28; US-SHELL-005; NFR-SND-07): in the E2E build
 * profile (`DWARFAI_BUILD_PROFILE=e2e pnpm build`), the music moves with the mode: Panel → Valle → Veta → Panel. At
 * every step exactly one window plays sound and it is the shown one, and the music each window hands over through the
 * UI-main session store is the same track, further along each time.
 *
 * Every page is muted in the main process first (`muteAppAudio`): Electron still reports a muted page that plays as
 * audible, and nothing sounds on the machine running the case. No provider CLI is on the PATH (`stubOnlyPath`).
 */

test.describe.configure({ timeout: 300_000 })

type Mode = 'panel' | 'valle' | 'veta'

/** The mode windows that play sound right now, read in the main process. */
function audibleModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents.isCurrentlyAudible())
      .map((w) => {
        const url = w.webContents.getURL()
        return url.includes('mode=valle') ? 'valle' : url.includes('mode=veta') ? 'veta' : 'panel'
      })
      .sort()
  )
}

/** The music slot of the UI-main session store (AMENDMENT-28), read through a page's own A-N17. */
async function storedMusic(
  page: Page
): Promise<{ on: boolean; track: string | null; positionMs: number } | undefined> {
  return (await page.evaluate('window.api.getUiSession().then((s) => s.music)')) as
    { on: boolean; track: string | null; positionMs: number } | undefined
}

/** Moves to `mode` from `from`, the way the mode lever asks (A-N13). */
async function moveTo(from: Page, mode: Mode): Promise<void> {
  const moved = (await from.evaluate(`window.api.moveToMode({ mode: '${mode}' })`)) as {
    ok: boolean
  }
  expect(moved.ok, `the build lists ${mode}`).toBe(true)
}

test.describe('one music across the modes (owner ruling 2026-10-24)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SHELL-005.AC03, NFR-SND-07, NFR-SND-03] Panel to Valle to Veta and back: one window plays at a time, the shown one, and it is the same track carried on', async () => {
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
    const { app, window: panel } = launched
    await muteAppAudio(app)
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(panel)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    // The first window of the run plays "Music at startup", alone.
    await expect.poll(() => audibleModes(app), { timeout: 30_000 }).toEqual(['panel'])

    // Panel → Valle: the Panel hands its track over and Valle carries it on.
    const valle = await showValle(app, panel)
    await expect.poll(() => audibleModes(app), { timeout: 15_000 }).toEqual(['valle'])
    const fromPanel = await storedMusic(valle)
    expect(fromPanel?.on).toBe(true)
    expect(fromPanel?.track, 'the Panel handed a track over').toEqual(expect.any(String))

    // Valle → Veta: the same track, further along; Veta plays the music too.
    const veta = await showVeta(app, valle)
    await expect.poll(() => audibleModes(app), { timeout: 15_000 }).toEqual(['veta'])
    const fromValle = await storedMusic(veta)
    expect(fromValle?.track).toBe(fromPanel!.track)
    expect(fromValle!.positionMs).toBeGreaterThan(fromPanel!.positionMs)

    // Veta → Panel: the same track again, the Panel alone audible.
    await moveTo(veta, 'panel')
    await expect.poll(() => audibleModes(app), { timeout: 15_000 }).toEqual(['panel'])
    const fromVeta = await storedMusic(panel)
    expect(fromVeta?.track).toBe(fromPanel!.track)
    expect(fromVeta!.positionMs).toBeGreaterThan(fromValle!.positionMs)
  })
})
