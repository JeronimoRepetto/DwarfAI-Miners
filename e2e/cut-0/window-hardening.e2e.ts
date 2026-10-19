import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { homeIn, launchApp, type LaunchedApp } from '../_harness/launchApp.ts'

/**
 * L9, cut 0 (moved from ISSUE-046, review R8B-02; TC-056-06; ADR-019 items 2–4): in the app's real Panel page, built by
 * the secure window factory of the cut-0 entry, a navigation away from the app entry and a new window are refused, and
 * the page's requests for the camera, notifications and the clipboard are denied. Nothing reaches the system browser:
 * `shell.openExternal` is replaced in the main process for the case.
 */

// Page-side scripts are passed as source text: this file is type-checked without the DOM library.
const PERMISSIONS_SCRIPT = `(async () => {
  const outcome = async (run) => {
    try {
      return 'resolved:' + String(await run())
    } catch (error) {
      return 'rejected:' + (error instanceof Error ? error.name : String(error))
    }
  }
  return {
    camera: await outcome(() => navigator.mediaDevices.getUserMedia({ video: true })),
    notifications: await outcome(() => Notification.requestPermission()),
    clipboard: await outcome(() => navigator.clipboard.readText())
  }
})()`

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: the hardened Panel window (ISSUE-046)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
  })

  async function panel(): Promise<LaunchedApp> {
    launched = await launchApp({ env: homeIn, tracePath: test.info().outputPath('trace.zip') })
    // A link the guard admits would go to the system browser: recorded here instead, never opened.
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __e2eOpened?: string[] }).__e2eOpened = opened
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    return launched
  }

  test('[ADR-019] location = https and window.open file stay on the app entry', async () => {
    const { app, window } = await panel()
    const entry = window.url()

    await window.evaluate(`location.href = 'https://example.org/'`)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(window.url(), 'a navigation away from the app entry is prevented').toBe(entry)

    const opened = await window.evaluate(
      `window.open(${JSON.stringify(pathToFileURL(process.execPath).href)}) === null`
    )
    expect(opened, 'window.open of a file gets no window').toBe(true)
    expect(window.url()).toBe(entry)
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      'no second window'
    ).toBe(1)
    expect(
      await app.evaluate(() => (globalThis as { __e2eOpened?: string[] }).__e2eOpened ?? []),
      'a file link never reaches the system browser'
    ).toEqual([])
    // Playwright keeps waiting for the prevented navigation to finish; a reload of the app entry ends that wait, so
    // the teardown can use the page.
    await window.reload({ waitUntil: 'load' })
    expect(window.url()).toBe(entry)
  })

  test('[ADR-019] getUserMedia, Notification.requestPermission and clipboard.readText are denied in the page', async () => {
    const { window } = await panel()

    const answers = (await window.evaluate(PERMISSIONS_SCRIPT)) as {
      camera: string
      notifications: string
      clipboard: string
    }

    expect(answers.camera).toMatch(/^rejected:/)
    expect(answers.notifications).toBe('resolved:denied')
    expect(answers.clipboard).toMatch(/^rejected:/)
  })
})
