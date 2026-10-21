import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { hostSection } from '../cut-3a/claudeStreamWorld.ts'

/*
 * What the Veta L9 cases share (ISSUE-290): showing the Veta window, declaring a mine the way the Mines page does, and
 * reading the Veta window's bounds in the main process. The page's own scripts are strings: the e2e project has no DOM
 * types.
 */

/** The Veta window's page, once UI main shows it. */
export async function showVeta(app: ElectronApplication, panel: Page): Promise<Page> {
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
export async function vetaBounds(
  app: ElectronApplication
): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('mode=veta'))
      ?.getBounds()
  )
  expect(bounds, 'the Veta window exists').toBeDefined()
  return bounds!
}

/** What the risen window shows: `chat`, `add`, or `none` when nothing has risen. */
export function risenContent(veta: Page): Promise<string> {
  return veta.evaluate(
    `(() => { const box = document.querySelector('[data-veta-risen][data-shown="true"]'); return box === null ? 'none' : box.dataset.content })()`
  ) as Promise<string>
}
