import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../../../scripts/os-lane/electronProcess'

/**
 * OS lane, L8 (17 §1.8): the Panel surface's always-on-top read-back (`applyAlwaysOnTop`, which
 * `ElectronWindows.panelSurface().setAlwaysOnTop` answers with) over a real Electron `BrowserWindow` of this platform
 * (13 FM-052; NFR-PLAT-04; ADR-024 item 9; TC-047-03). The answer is the window's own read-back, never the request: a
 * pin the window took reads back `true`, an unpin `false`, and a pin that never reached the window (the shape of an
 * OS refusal: the request is dropped and the real window is asked) reads back `false` from the real window, the same
 * way on every OS. A refusal by a real full-screen app is the manual per-OS check of 13 FM-052.
 *
 * The app is a throwaway one in a temp folder with its own `userData` folder, never a DwarfAI-Miners running here. Its
 * window is never shown. Its main script is CommonJS and catches every load or run error itself, printing it and
 * exiting non-zero, so no Electron error dialog can appear. The surface helpers are the repository's own files,
 * compiled to CommonJS for the run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCES = [
  { from: path.join(HERE, 'panelSurface.ts'), to: path.join('adapters', 'panelSurface.js') },
  {
    from: path.join(HERE, '..', 'domain', 'panelBounds.ts'),
    to: path.join('domain', 'panelBounds.js')
  }
]
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 120_000

const MAIN = `'use strict'
function fail(error) {
  try {
    console.log('error ' + String((error && error.stack) || error).split('\\n')[0])
  } finally {
    process.exit(1)
  }
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
try {
  const { app, BrowserWindow } = require('electron')
  const { applyAlwaysOnTop } = require('./adapters/panelSurface.js')
  app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
  app.on('window-all-closed', () => {})
  app.whenReady().then(() => {
    try {
      const window = new BrowserWindow({
        show: false,
        frame: false,
        width: 320,
        height: 240,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      const pinned = applyAlwaysOnTop(window, true)
      const pinnedReadBack = window.isAlwaysOnTop()
      const unpinned = applyAlwaysOnTop(window, false)
      const unpinnedReadBack = window.isAlwaysOnTop()
      const refused = applyAlwaysOnTop(
        { setAlwaysOnTop: () => {}, isAlwaysOnTop: () => window.isAlwaysOnTop() },
        true
      )
      window.destroy()
      console.log(JSON.stringify({ pinned, pinnedReadBack, unpinned, unpinnedReadBack, refused }))
      app.exit(0)
    } catch (error) {
      fail(error)
    }
  }, fail)
} catch (error) {
  fail(error)
}
`

async function writeApp(appDir: string): Promise<void> {
  for (const { from, to } of SOURCES) {
    const compiled = await transformWithEsbuild(readFileSync(from, 'utf8'), from, {
      loader: 'ts',
      format: 'cjs'
    })
    const target = path.join(appDir, to)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, compiled.code)
  }
  writeFileSync(path.join(appDir, 'main.cjs'), MAIN)
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-panel-surface-os-test', main: 'main.cjs' })
  )
}

/** Linux runners have no setuid sandbox helper; the window needs the display session, not the sandbox. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox'] : []
}

async function alwaysOnTopReadsBack(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-panel-surface-'))
  const appDir = path.join(root, 'app')
  let instance: ElectronProcess | undefined
  try {
    // The app is written completely before Electron starts on it.
    await writeApp(appDir)
    instance = ElectronProcess.start(
      appDir,
      { DWARFAI_OS_TEST_USER_DATA: path.join(root, 'user-data') },
      platformFlags()
    )
    const line = await instance.firstLine(START_TIMEOUT_MS)
    // AMENDED: a run that prints no observation (nothing within the wait, or the app's own `error …` line) now fails
    // with the app's exit state, its stdout and its stderr tail, as the preload OS test does. Before, an empty run
    // failed as "printed: null" and an `error …` line as a bare JSON SyntaxError, so a one-off OS-lane failure under
    // load left no evidence of which step failed.
    if (line === null || !line.startsWith('{')) {
      expect.fail(
        `the test app printed no observation (waited up to ${START_TIMEOUT_MS} ms)\n${instance.describe()}`
      )
    }
    // AMENDED: parsed only once the line is known to be the app's JSON observation (see above).
    const result = JSON.parse(line) as Record<string, boolean> | null
    // AMENDED: the message also carries the app's state and output.
    expect(result, `printed: ${line}\n${instance.describe()}`).not.toBeNull()
    // The answer is the window's own read-back, whatever it is on this OS.
    expect(result?.pinned).toBe(result?.pinnedReadBack)
    expect(result?.unpinned).toBe(false)
    expect(result?.unpinnedReadBack).toBe(false)
    // A pin that never reached the window reads back false from the real window.
    expect(result?.refused).toBe(false)
    // AMENDED: the message carries the app's exit state and stderr tail when it does not exit cleanly.
    expect(await instance.exited, `the test app exits on its own\n${instance.describe()}`).toBe(0)
  } finally {
    await instance?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

const linuxSession = process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined

describe.runIf(
  process.platform === 'win32' ||
    process.platform === 'darwin' ||
    (process.platform === 'linux' && linuxSession)
)(`Panel always on top on ${process.platform}`, () => {
  it(
    '[FM-052] always on top refused by the OS reads back false the same way on every OS',
    alwaysOnTopReadsBack,
    TEST_TIMEOUT_MS
  )
})
