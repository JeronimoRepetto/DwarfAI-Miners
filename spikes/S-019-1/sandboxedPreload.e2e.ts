import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import ts from 'typescript'
import { launchApp, type LaunchedApp } from '../../e2e/_harness/launchApp.ts'

/**
 * Spike S-019-1, L9 (testing strategy `17` §4; ADR-019 item 1; spike register S-019-1).
 *
 * Question: on Electron 44, does a renderer created with `sandbox: true` still get a working preload facade
 * (`contextBridge`, `ipcRenderer`) and the path of a dropped file (`webUtils.getPathForFile`), which the composer's
 * drag-and-drop attachments need?
 *
 * Inside the built app (the ISSUE-312 harness), a test window is created in the main process with `sandbox: true`,
 * context isolation, no Node integration and its own in-memory session. It first tries the found tree's preload
 * (`out/preload/index.cjs`, one CommonJS file since ISSUE-045) and records whether it loads sandboxed; then it loads the spike's own facade
 * (`spikes/S-019-1/preload.ts`, compiled to CommonJS here), asserts the sandbox flag, makes one `ipcRenderer` round
 * trip and drops a file. A drag from the OS file manager cannot be synthesised; the drop here carries a disk-backed
 * `File` obtained through a file input (Playwright `setInputFiles`), the same `File` kind a real drop hands the page.
 * Kept afterwards as the E2E drag-and-drop case under the sandbox.
 *
 * Set `S0191_REPORT=<file>` to write the observations as JSON (the spike record's raw output).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FOUND_PRELOAD = path.join(REPO, 'out', 'preload', 'index.cjs')
const FACADE_SOURCE = path.join(REPO, 'spikes', 'S-019-1', 'preload.ts')

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>S-019-1</title></head>
<body>
  <input id="picker" type="file">
  <div id="zone" style="width:200px;height:120px;border:1px dashed">drop here</div>
  <script>
    const zone = document.getElementById('zone')
    zone.addEventListener('dragover', (event) => event.preventDefault())
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      const file = event.dataTransfer.files[0]
      window.__dropped = window.spike ? window.spike.pathForFile(file) : null
    })
  </script>
</body></html>
`

/** What the page reports through the facade (`window.spike`), or null when the facade is absent. */
interface FacadeFacts {
  sandboxed: boolean
  fullNodeRequire: boolean
  ping: string
  syntheticPath: string
}

// Page-side scripts are passed as source text: this file is type-checked without the DOM library.
const FACTS_SCRIPT = `(async () => {
  const spike = window.spike
  if (!spike) return null
  return {
    sandboxed: spike.sandboxed,
    fullNodeRequire: spike.fullNodeRequire,
    ping: await spike.ping('s0191'),
    syntheticPath: spike.pathForFile(new File(['x'], 'synthetic.txt'))
  }
})()`

const DROP_SCRIPT = `(() => {
  const file = document.getElementById('picker').files[0]
  if (!file) return null
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const zone = document.getElementById('zone')
  const init = { dataTransfer: transfer, bubbles: true, cancelable: true }
  zone.dispatchEvent(new DragEvent('dragover', init))
  zone.dispatchEvent(new DragEvent('drop', init))
  return window.__dropped ?? null
})()`

/** `webContents.getLastWebPreferences()` exists on Electron 44 but is missing from its type declarations. */
interface WithLastWebPreferences {
  getLastWebPreferences(): {
    sandbox?: boolean
    contextIsolation?: boolean
    nodeIntegration?: boolean
  } | null
}

/** A preload source as the CommonJS script a sandboxed preload must be. */
function toCommonJs(source: string, outFile: string): string {
  const { outputText } = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  writeFileSync(outFile, outputText)
  return outFile
}

const samePath = (a: string, b: string): boolean =>
  realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()

test.describe('S-019-1: preload under sandbox true (ADR-019 item 1)', () => {
  let launched: LaunchedApp | undefined
  let workDir = ''

  test.beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0191-'))
  })

  test.afterEach(async () => {
    if (launched) {
      await launched.app
        .evaluate(({ ipcMain }) => ipcMain.removeHandler('s0191:ping'))
        .catch(() => undefined)
      await launched.teardown()
      launched = undefined
    }
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test("[S-019-1, ADR-019] with sandbox true the spike's preload facade answers and a dropped file's path reaches the renderer", async () => {
    launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    const { app } = launched
    const pageFile = path.join(workDir, 'page.html')
    writeFileSync(pageFile, PAGE)
    const facade = toCommonJs(FACADE_SOURCE, path.join(workDir, 'preload.cjs'))

    // One window per preload, created the way ADR-019 item 1 prescribes; the flags are read back from Electron.
    const openWindow = (preload: string, tag: string) =>
      app.evaluate(
        async ({ BrowserWindow }, args) => {
          const win = new BrowserWindow({
            show: false,
            webPreferences: {
              preload: args.preload,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              partition: 's0191-spike'
            }
          })
          let preloadError: string | null = null
          win.webContents.on('preload-error', (_event, _path, error) => {
            preloadError = error.message.split('\n')[0] ?? 'error'
          })
          await win.loadFile(args.page, { query: { w: args.tag } })
          const contents = win.webContents as unknown as WithLastWebPreferences
          const prefs = contents.getLastWebPreferences() ?? {}
          const found = (await win.webContents.executeJavaScript(
            "typeof window.api === 'object' || typeof window.spike === 'object'"
          )) as boolean
          return {
            id: win.id,
            sandbox: prefs.sandbox,
            contextIsolation: prefs.contextIsolation,
            nodeIntegration: prefs.nodeIntegration,
            preloadError,
            bridgeExposed: found
          }
        },
        { preload, page: pageFile, tag }
      )
    const closeWindow = (id: number) =>
      app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(), id)

    // The found tree's preload, as built (`pnpm build`): recorded, not asserted.
    const found = await openWindow(FOUND_PRELOAD, 'found')
    await closeWindow(found.id)
    // The same build output with only its module format changed to CommonJS: recorded, not asserted.
    const foundAsCjs = await openWindow(
      toCommonJs(FOUND_PRELOAD, path.join(workDir, 'found-preload.cjs')),
      'found-cjs'
    )
    await closeWindow(foundAsCjs.id)

    await app.evaluate(({ ipcMain }) => {
      ipcMain.handle('s0191:ping', (_event, value: string) => `pong:${value}`)
    })
    const spikeWindow = await openWindow(facade, 'spike')
    // Playwright's page for the test window, told apart from the found-preload one by its query.
    await expect
      .poll(() => app.windows().some((candidate) => candidate.url().endsWith('?w=spike')))
      .toBe(true)
    const page = app.windows().find((candidate) => candidate.url().endsWith('?w=spike'))
    if (!page) throw new Error('no page for the test window')

    // The flag first: without it this case proves nothing about the sandbox. The value is the effective one Electron
    // applied, so `sandbox: false` fails here; leaving the option out does not, because Electron 44 sandboxes a
    // renderer by default (observed while breaking this case, spike-results/S-019-1.md).
    expect(spikeWindow.sandbox, 'the test window is created with sandbox: true').toBe(true)
    expect(spikeWindow.contextIsolation).toBe(true)
    expect(spikeWindow.nodeIntegration).toBe(false)
    expect(spikeWindow.preloadError, 'the facade loads sandboxed').toBeNull()
    expect(spikeWindow.bridgeExposed, 'the facade is exposed to the page').toBe(true)

    const facts = (await page.evaluate(FACTS_SCRIPT)) as FacadeFacts | null
    expect(facts, 'window.spike exists in the page').not.toBeNull()
    expect(facts?.sandboxed, 'the renderer reports it is sandboxed').toBe(true)
    expect(facts?.fullNodeRequire, 'the sandboxed preload has no full Node require').toBe(false)
    expect(facts?.ping, 'the ipcRenderer round trip answers').toBe('pong:s0191')
    expect(facts?.syntheticPath, 'a File made in the page has no path').toBe('')

    // The drop: a disk-backed File (name with a space and non-ASCII letters) handed to the drop zone.
    const dropped = path.join(workDir, 'dropped file ñ.txt')
    writeFileSync(dropped, 'attachment')
    await page.setInputFiles('#picker', dropped)
    const received = (await page.evaluate(DROP_SCRIPT)) as string | null
    expect(received, "the dropped file's path reaches the renderer").not.toBeNull()
    expect(received !== null && samePath(received, dropped), 'it is the dropped file').toBe(true)

    await closeWindow(spikeWindow.id)

    const report = process.env['S0191_REPORT']
    if (report) {
      const scrub = (text: string | null): string | null =>
        text === null ? null : text.split(REPO).join('<repo>').split(workDir).join('<tmp>')
      writeFileSync(
        report,
        `${JSON.stringify(
          {
            platform: process.platform,
            electron: await app.evaluate(() => process.versions.electron),
            foundPreload: {
              file: 'out/preload/index.mjs',
              sandbox: found.sandbox,
              preloadError: scrub(found.preloadError),
              bridgeExposed: found.bridgeExposed
            },
            foundPreloadAsCommonJs: {
              file: 'out/preload/index.mjs transpiled to CommonJS',
              sandbox: foundAsCjs.sandbox,
              preloadError: scrub(foundAsCjs.preloadError),
              bridgeExposed: foundAsCjs.bridgeExposed
            },
            spikeFacade: {
              file: 'spikes/S-019-1/preload.ts (compiled to CommonJS)',
              sandbox: spikeWindow.sandbox,
              contextIsolation: spikeWindow.contextIsolation,
              nodeIntegration: spikeWindow.nodeIntegration,
              preloadError: scrub(spikeWindow.preloadError),
              ...facts,
              droppedPathReachedRenderer: received !== null && samePath(received, dropped)
            }
          },
          null,
          2
        )}\n`
      )
    }
  })
})
