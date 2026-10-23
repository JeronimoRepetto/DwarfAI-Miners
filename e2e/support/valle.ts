import { expect, type ElectronApplication, type Page } from '@playwright/test'

/*
 * What the Valle L9 cases share (ISSUE-299): moving to Valle from a page the way the mode lever will (A-N13), finding
 * the Valle window's page, and reading the Valle window in the main process. The page's own scripts are strings: the
 * e2e project has no DOM types.
 */

/** A rectangle in DIP, as Electron reports one. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Mutes every page of the app, and every page created after, in the main process (Electron `setAudioMuted`): the Valle
 * window plays its current mine's room tone from ISSUE-307 on, and an L9 case never sounds on the machine running it.
 */
export async function muteAppAudio(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents }) => {
    for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true)
    const marked = electronApp as unknown as { dwarfaiE2eMuted?: boolean }
    if (marked.dwarfaiE2eMuted === true) return
    marked.dwarfaiE2eMuted = true
    electronApp.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true))
  })
}

/** Whether the Valle window's page is muted (`muteAppAudio`), read in the main process. */
export function valleAudioMuted(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getURL().includes('mode=valle'))
      .every((contents) => contents.isAudioMuted())
  )
}

/**
 * The Valle window's page, once UI main shows it. Polled, never found once: the window may still be loading.
 * AMENDED for ISSUE-307: every page is muted first (`muteAppAudio`), so the Valle window's sound is never heard.
 */
export async function showValle(app: ElectronApplication, from: Page): Promise<Page> {
  await muteAppAudio(app)
  const moved = (await from.evaluate("window.api.moveToMode({ mode: 'valle' })")) as {
    ok: boolean
  }
  expect(moved.ok, 'the build lists Valle: build it with DWARFAI_BUILD_PROFILE=e2e').toBe(true)
  let page: Page | undefined
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes('mode=valle'))
        return page !== undefined
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await page!.waitForSelector('[data-valle-root]')
  return page!
}

/** What Electron main reports of the Valle window and of the window it was entered from. */
export interface ValleWindowFacts {
  readonly found: boolean
  readonly visible: boolean
  readonly alwaysOnTop: boolean
  readonly bounds: Bounds
  readonly content: Bounds
  /** The id of the display matching the Valle window's bounds. */
  readonly display: number
  /** The id and work area of the display matching the source window's bounds. */
  readonly sourceDisplay: number
  readonly sourceWorkArea: Bounds
}

/** The Valle window, and the display of the window whose URL has no mode (the Panel), read in the main process. */
export function valleFacts(app: ElectronApplication): Promise<ValleWindowFacts> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const valle = windows.find((w) => w.webContents.getURL().includes('mode=valle'))
    const panel = windows.find((w) => !w.webContents.getURL().includes('mode='))
    const none = { x: 0, y: 0, width: 0, height: 0 }
    const source =
      panel === undefined
        ? screen.getPrimaryDisplay()
        : screen.getDisplayMatching(panel.getBounds())
    if (valle === undefined) {
      return {
        found: false,
        visible: false,
        alwaysOnTop: false,
        bounds: none,
        content: none,
        display: -1,
        sourceDisplay: source.id,
        sourceWorkArea: source.workArea
      }
    }
    const bounds = valle.getBounds()
    return {
      found: true,
      visible: valle.isVisible(),
      alwaysOnTop: valle.isAlwaysOnTop(),
      bounds,
      content: valle.getContentBounds(),
      display: screen.getDisplayMatching(bounds).id,
      sourceDisplay: source.id,
      sourceWorkArea: source.workArea
    }
  })
}

/**
 * Waits until no dive, climb or swap runs in Valle (ISSUE-301; 07 machine 28): input is ignored for the whole of a dive
 * or a climb (S28.09, S28.14), so a case presses the next control only once the run settled.
 */
export async function valleSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-valle-root]')).toHaveAttribute('data-motion', 'none', {
    timeout: 10_000
  })
}
