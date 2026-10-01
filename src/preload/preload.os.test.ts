import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../scripts/os-lane/electronProcess'

/**
 * OS lane, L8 (17 §1.8): the built preload never throws in a real sandboxed renderer (14 §1.4; ADR-019 items 1, 7).
 *
 * In real Electron, `ipcRenderer.send` and `ipcRenderer.invoke` run the structured clone algorithm on the payload,
 * so a value it cannot copy (a function here) fails inside the preload, which a mocked `ipcRenderer` (the L6 contract,
 * `preload.contract.test.ts`) cannot show. This test builds the preload with the repository's own build config (the
 * same `preload/index.cjs` `pnpm build` writes to `out/`, built here into a temp folder so the lane does not depend
 * on an earlier build), loads it in a `BrowserWindow` with `sandbox: true`, context isolation and an in-memory
 * session, and calls one send member and one invoke member from the page with a function.
 *
 * The throwaway app lives in a temp folder with its own `userData` folder, never a DwarfAI-Miners running here. Its
 * main script is a CommonJS bootstrap that logs any load error or uncaught exception and exits non-zero, so Electron
 * never shows an error dialog; the process is always ended in `finally`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const START_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000

/** Logs any failure and exits non-zero: with a listener, Electron shows no error dialog. */
const BOOTSTRAP = `'use strict'
const fail = (label, error) => {
  console.log(label + ' ' + String(error && error.stack ? error.stack : error).replace(/\\r?\\n/g, ' | '))
  process.exit(2)
}
process.on('uncaughtException', (error) => fail('FATAL', error))
process.on('unhandledRejection', (error) => fail('FATAL', error))
try {
  require('./app.cjs')
} catch (error) {
  fail('LOAD_ERROR', error)
}
`

// Runs in the page (the main world): it reaches the preload only through `window.api`.
const PAGE_SCRIPT = `(async () => {
  const api = window.api
  if (!api) return { api: false }
  const uncloneable = () => 'not cloneable'
  const facts = { api: true }
  try {
    api.reportRendererDiagnostic(uncloneable)
    facts.send = 'returned'
  } catch (error) {
    facts.send = 'threw'
  }
  try {
    const pending = api.sendDwarfText(uncloneable)
    facts.invoke = pending && typeof pending.then === 'function' ? 'promise' : typeof pending
    try {
      await pending
      facts.settled = 'resolved'
    } catch (error) {
      facts.settled = error instanceof Error ? 'rejected with an Error' : 'rejected with ' + typeof error
    }
  } catch (error) {
    facts.invoke = 'threw'
  }
  // Control: a cloneable value still crosses both ways.
  api.reportRendererDiagnostic({ control: true })
  facts.control = await api.sendDwarfText('control')
  return facts
})()`

const APP = `'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')

app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
const received = []
ipcMain.on('diag:renderer:report', (_event, payload) => received.push(['send', payload]))
ipcMain.handle('dwarf:sendText', (_event, payload) => {
  received.push(['invoke', payload])
  return 'served'
})
// The test window is hidden and closed by app.exit: never quit on window-all-closed.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: process.env.DWARFAI_OS_TEST_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'preload-never-throw'
    }
  })
  await window.loadURL('data:text/html,<!doctype html><title>preload</title>')
  const facts = await window.webContents.executeJavaScript(${JSON.stringify(PAGE_SCRIPT)})
  console.log(JSON.stringify({ facts, received }))
  app.exit(0)
})
`

/** Builds the preload with the repository's config into `outDir`; returns the built script's path. */
async function buildPreload(outDir: string): Promise<string> {
  const nodeEnv = process.env.NODE_ENV
  try {
    const resolved = await resolveConfig(
      {
        configFile: resolve(REPO_ROOT, 'electron.vite.config.ts'),
        build: { outDir },
        logLevel: 'silent'
      },
      'build',
      'production'
    )
    const preloadConfig = resolved.config?.preload
    if (preloadConfig === undefined) throw new Error('electron.vite.config.ts has no preload build')
    await build({ ...preloadConfig, configFile: false, logLevel: 'silent' })
  } finally {
    process.env.NODE_ENV = nodeEnv
  }
  return join(outDir, 'preload', 'index.cjs')
}

function writeApp(appDir: string): void {
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'app.cjs'), APP)
  writeFileSync(join(appDir, 'main.cjs'), BOOTSTRAP)
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-preload-never-throw-os-test', main: 'main.cjs' })
  )
}

/** Linux runners have no display and no setuid sandbox helper; the renderer's sandboxed preload needs neither. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []
}

async function uncloneablePayloadsNeverThrow(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-preload-never-throw-'))
  let electron: ElectronProcess | undefined
  try {
    const preload = await buildPreload(join(root, 'out'))
    const appDir = join(root, 'app')
    writeApp(appDir)
    electron = ElectronProcess.start(
      appDir,
      {
        DWARFAI_OS_TEST_USER_DATA: join(root, 'user-data'),
        DWARFAI_OS_TEST_PRELOAD: preload
      },
      platformFlags()
    )
    const line = await electron.firstLine(START_TIMEOUT_MS)
    expect(line, 'the test app printed its observation').toMatch(/^\{/)
    const { facts, received } = JSON.parse(line ?? 'null') as {
      facts: Record<string, unknown>
      received: unknown[]
    }
    expect(facts).toEqual({
      api: true,
      // A send that cannot cross is dropped, as main would drop a payload it refuses.
      send: 'returned',
      // An invoke always answers with a promise; one that cannot cross rejects with an Error.
      invoke: 'promise',
      settled: 'rejected with an Error',
      control: 'served'
    })
    // Main received only the control calls: the uncloneable payloads never crossed.
    expect(received).toEqual([
      ['send', { control: true }],
      ['invoke', 'control']
    ])
    expect(await electron.exited, 'the test app exits on its own').toBe(0)
  } finally {
    await electron?.stop()
    // Chromium's helper processes can hold the profile for a moment after the app exits (EPERM, EBUSY on Windows).
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

const TITLE =
  '[ADR-019] the built preload never throws in a sandboxed renderer when a member is given a value structured clone cannot copy'

describe.runIf(process.platform === 'win32')('preload never throws on Windows', () => {
  it(TITLE, uncloneablePayloadsNeverThrow, TEST_TIMEOUT_MS)
})

describe.runIf(process.platform === 'darwin')('preload never throws on macOS', () => {
  it(TITLE, uncloneablePayloadsNeverThrow, TEST_TIMEOUT_MS)
})

describe.runIf(process.platform === 'linux')('preload never throws on Linux', () => {
  it(TITLE, uncloneablePayloadsNeverThrow, TEST_TIMEOUT_MS)
})
