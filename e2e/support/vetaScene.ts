import { setTimeout as sleep } from 'node:timers/promises'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * Helpers that bring the built app (E2E build profile, `DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md) to a
 * Veta scene and read it, for a case outside the Playwright runner (the perf lane, ISSUE-297; `17` §1.9, §1.11).
 * Everything goes through what the app already exposes: the renderer's own `window.api` members and Electron's
 * main process through Playwright's `evaluate` (no test hook in production code, R14). The page scripts are strings:
 * the e2e project has no DOM types.
 */

/** Polls `read` every 250 ms until it answers `want`, or throws `what` with the last answer after `timeoutMs`. */
export async function waitFor<T>(
  read: () => Promise<T>,
  want: T,
  what: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  for (;;) {
    last = await read()
    if (last === want) return
    if (Date.now() > deadline) {
      throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`)
    }
    await sleep(250)
  }
}

/** The Veta window's page, once a move to Veta (A-N13 `moveToMode`, asked from the Panel's renderer) shows it. */
export async function showVeta(app: ElectronApplication, panel: Page): Promise<Page> {
  const moved = (await panel.evaluate("window.api.moveToMode({ mode: 'veta' })")) as {
    ok: boolean
  }
  if (!moved.ok) {
    throw new Error(
      `the build does not list Veta: build it with DWARFAI_BUILD_PROFILE=e2e (${JSON.stringify(moved)})`
    )
  }
  let page: Page | undefined
  await waitFor(
    async () => {
      page = app.windows().find((p) => p.url().includes('mode=veta'))
      return page !== undefined
    },
    true,
    'the Veta window opens',
    15_000
  )
  await page!.waitForSelector('[data-veta-root]')
  return page!
}

/** The life state the Veta root draws (`data-life`, 07 machine 20). */
export const lifeOf = (veta: Page): Promise<string | null> =>
  veta.evaluate(
    "document.querySelector('[data-veta-root]')?.getAttribute('data-life') ?? null"
  ) as Promise<string | null>

/** The OS process id of `page`'s renderer, read from its window in the main process. */
export async function rendererPidOf(app: ElectronApplication, page: Page): Promise<number> {
  const owner = await app.browserWindow(page)
  return owner.evaluate((window) => window.webContents.getOSProcessId())
}

/**
 * Declares `folder` as a mine the way the Mines page does (A-N `declareMine`), the OS folder picker answered in the
 * main process, and answers its id once the Host holds it enterable.
 */
export async function declareMine(
  app: ElectronApplication,
  panel: Page,
  folder: string
): Promise<string> {
  await app.evaluate(({ dialog }, picked) => {
    ;(dialog as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [picked] })
  }, folder)
  const declared = (await panel.evaluate('window.api.declareMine()')) as {
    outcome?: string
    mineId?: string
  }
  if (declared.outcome !== 'added' || declared.mineId === undefined) {
    throw new Error(`declareMine did not add the folder: ${JSON.stringify(declared)}`)
  }
  return declared.mineId
}

/** Opens the Panel's one mine from its Map marker and waits until its dwarf is drawn on the mine column. */
export async function openMineColumn(panel: Page): Promise<void> {
  await panel.locator('.dm-marker').first().click({ timeout: 30_000 })
  await panel.locator('.shell-mine').waitFor({ timeout: 30_000 })
  await panel
    .locator('.shell-mine button.dm-dwarf[data-dwarf]')
    .first()
    .waitFor({ timeout: 60_000 })
}

/** The name the counter of sprite frame changes takes on the observed page (a harness global, never the app's). */
const SPRITE_FRAMES = '__perfSpriteFrames'

/**
 * Starts counting, in `page`'s renderer, every sprite frame change: each change of a `.dm-sprite__strip` element's
 * inline style, which is how the one shared frame clock moves a sprite to its next frame (SpriteStrip.vue). Installed
 * with `webContents.executeJavaScript` from the main process, so it reads the page whether its window is shown or
 * hidden.
 */
export async function watchSpriteFrames(app: ElectronApplication, page: Page): Promise<void> {
  const owner = await app.browserWindow(page)
  await owner.evaluate(
    (window, counter) =>
      window.webContents.executeJavaScript(`(() => {
        if (globalThis.${counter} !== undefined) return
        globalThis.${counter} = { frames: 0 }
        new MutationObserver((changes) => {
          for (const change of changes) {
            if (change.target.classList && change.target.classList.contains('dm-sprite__strip')) {
              globalThis.${counter}.frames++
            }
          }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] })
      })()`),
    SPRITE_FRAMES
  )
}

/**
 * What the sprite watch saw so far: the frame changes counted and the sprites drawn now; whether the page's window is
 * on screen, as Electron main knows it (`BrowserWindow.isVisible()`); and the page's own `document.hidden`, which
 * for a hidden frameless window is a platform detail (`src/contracts/wire/today.ts`, `panelVisibilityChanged`).
 */
export interface SpriteFrameReading {
  readonly frames: number
  readonly sprites: number
  readonly visible: boolean
  readonly documentHidden: boolean
}

/** Reads the sprite watch of `watchSpriteFrames` on `page` and sets its count back to zero. */
export async function takeSpriteFrames(
  app: ElectronApplication,
  page: Page
): Promise<SpriteFrameReading> {
  const owner = await app.browserWindow(page)
  return owner.evaluate(async (window, counter) => {
    const seen = (await window.webContents.executeJavaScript(`(() => {
        const frames = globalThis.${counter}?.frames ?? -1
        if (globalThis.${counter} !== undefined) globalThis.${counter}.frames = 0
        return {
          frames,
          sprites: document.querySelectorAll('.dm-sprite__strip').length,
          documentHidden: document.hidden
        }
      })()`)) as { frames: number; sprites: number; documentHidden: boolean }
    return { ...seen, visible: window.isVisible() }
  }, SPRITE_FRAMES)
}
