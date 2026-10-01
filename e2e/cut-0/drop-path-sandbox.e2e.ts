import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { homeIn, launchApp, type LaunchedApp } from '../_harness/launchApp.ts'

/**
 * L9, cut 0 (moved from ISSUE-045, review R8B-02; TC-056-06; S-019-1 Decision; 13 FM-045): the Panel of the cut-0
 * entry runs sandboxed (the S-019-1 record decides it for Windows; macOS and Linux are its owner steps), its generated
 * CommonJS preload loads with no `preload-error`, and a dropped disk-backed file yields its absolute path through A-X1
 * `pathForDroppedFile`. As in the spike, the drop carries the same kind of disk-backed `File` a real drop hands the
 * page; a drag from the OS file manager itself is a manual check.
 */

// Page-side scripts are passed as source text: this file is type-checked without the DOM library (as the S-019-1
// spike case does).
const PRELOAD_HELPER_SCRIPT = `typeof window.api?.pathForDroppedFile`

const ADD_SOURCE_SCRIPT = `(() => {
  const input = document.createElement('input')
  input.type = 'file'
  input.id = 'e2e-drop-source'
  input.style.display = 'none'
  document.body.append(input)
})()`

const DROP_SCRIPT = `(async () => {
  const input = document.getElementById('e2e-drop-source')
  const picked = input.files[0]
  const zone = document.createElement('div')
  document.body.append(zone)
  const answer = new Promise((resolve) => {
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const file = event.dataTransfer.files[0]
      resolve(file === undefined ? '' : window.api.pathForDroppedFile(file))
    })
  })
  const transfer = new DataTransfer()
  transfer.items.add(picked)
  const init = { dataTransfer: transfer, bubbles: true, cancelable: true }
  zone.dispatchEvent(new DragEvent('dragover', init))
  zone.dispatchEvent(new DragEvent('drop', init))
  const path = await answer
  zone.remove()
  input.remove()
  return path
})()`

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: the dropped-file path under the sandbox (ISSUE-045)', () => {
  let launched: LaunchedApp | undefined
  let dir = ''

  test.afterEach(async () => {
    try {
      await launched?.teardown({ stopEverything: true })
    } finally {
      // A failed teardown still fails the case, and the dropped file's folder still goes (the run's leftover check).
      launched = undefined
      if (dir !== '') rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      dir = ''
    }
  })

  test('[S-019-1, FM-045] under sandbox true a dropped file yields its absolute path and the window raises no preload-error', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-drop-'))
    const file = path.join(dir, 'dropped file ñ.txt')
    writeFileSync(file, 'drop')
    launched = await launchApp({ env: homeIn, tracePath: test.info().outputPath('trace.zip') })
    const { app, window } = launched

    // The Panel's web preferences as Electron applied them, and its preload errors from a fresh load on.
    const sandboxed = await app.evaluate(({ BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows()[0]
      if (panel === undefined) throw new Error('the app has no window')
      const errors: string[] = []
      ;(globalThis as { __e2ePreloadErrors?: string[] }).__e2ePreloadErrors = errors
      panel.webContents.on('preload-error', (_event, preloadPath, error) =>
        errors.push(`${preloadPath}: ${error.message}`)
      )
      // `getLastWebPreferences()` exists on Electron 44 but is missing from its type declarations (as in S-019-1).
      const contents = panel.webContents as unknown as {
        getLastWebPreferences(): { sandbox?: boolean } | null
      }
      return contents.getLastWebPreferences()?.sandbox === true
    })
    expect(sandboxed, 'the Panel runs with sandbox: true').toBe(true)
    await window.reload({ waitUntil: 'load' })
    expect(
      await app.evaluate(
        () => (globalThis as { __e2ePreloadErrors?: string[] }).__e2ePreloadErrors ?? []
      )
    ).toEqual([])
    expect(await window.evaluate(PRELOAD_HELPER_SCRIPT)).toBe('function')

    // A disk-backed File, as a drop hands it to the page, dropped on a zone of the page's own.
    await window.evaluate(ADD_SOURCE_SCRIPT)
    await window.setInputFiles('#e2e-drop-source', file)
    const dropped = (await window.evaluate(DROP_SCRIPT)) as string

    expect(path.isAbsolute(dropped), 'an absolute path').toBe(true)
    expect(realpathSync(dropped)).toBe(realpathSync(file))
  })
})
