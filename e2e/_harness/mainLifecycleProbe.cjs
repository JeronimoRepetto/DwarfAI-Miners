'use strict'
// Preloaded into a test-launched app's main process with Electron's `-r` switch (`launchApp.ts`), after
// `mainErrorGuard.cjs` and before the app's own main file: it writes the main process's timeline, one JSON line per
// event, to the file `DWARFAI_E2E_MAIN_LIFECYCLE` names, inside the profile. The teardown keeps that file beside the
// case's trace, so a failed case shows what the app did, which the trace (the page only) and the deleted profile do not:
//
// - every web contents from its creation: its loads and navigations (main frame and sub-frames), the load's end, a
//   failed load, a renderer that went away (with its reason) and its destruction;
// - the app's start and quit: `ready`, `window-all-closed`, `before-quit` (and whether a listener turned it down),
//   `will-quit`, `quit`, and the process `exit` with its code;
// - the main thread's stalls: an event-loop gap of STALL_MS or more, with its length, which tells a blocked main
//   process from a slow one.
//
// Test-only; no production code loads it. It never throws into the app: every step is caught, and a timeline that
// cannot be written is simply absent.
const fs = process.getBuiltinModule('node:fs')

const file = process.env.DWARFAI_E2E_MAIN_LIFECYCLE
/** The shortest event-loop gap recorded as a stall. */
const STALL_MS = 250
const TICK_MS = 50
const started = Date.now()

function note(event, details) {
  if (!file) return
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now() - started, event, ...details })}\n`)
  } catch {
    // Nothing to record into: the case still runs.
  }
}

function watchContents(contents) {
  const id = contents.id
  const type = contents.getType()
  note('web-contents-created', { webContents: id, type })
  contents.on('did-start-loading', () => note('did-start-loading', { webContents: id }))
  contents.on('did-stop-loading', () => note('did-stop-loading', { webContents: id }))
  contents.on('did-finish-load', () => note('did-finish-load', { webContents: id }))
  contents.on('did-start-navigation', (details) =>
    note('did-start-navigation', {
      webContents: id,
      url: details.url,
      mainFrame: details.isMainFrame,
      sameDocument: details.isSameDocument
    })
  )
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) =>
    note('did-fail-load', { webContents: id, code, description, url, mainFrame })
  )
  contents.on('render-process-gone', (_event, details) =>
    note('render-process-gone', {
      webContents: id,
      reason: details.reason,
      exitCode: details.exitCode
    })
  )
  contents.on('unresponsive', () => note('unresponsive', { webContents: id }))
  contents.on('destroyed', () => note('destroyed', { webContents: id }))
}

try {
  // The house way of a harness preload to Electron (trayProbe.cjs).
  const { app } = process.getBuiltinModule('node:module').createRequire(__filename)('electron')
  note('main-start', { pid: process.pid })
  app.on('web-contents-created', (_event, contents) => {
    try {
      watchContents(contents)
    } catch {
      // A web contents the probe cannot watch is left alone.
    }
  })
  app.on('ready', () => note('ready'))
  app.on('window-all-closed', () => note('window-all-closed'))
  // Registered first, so it sees the quit before the app's listeners; whether one of them turned it down is read on
  // the next turn, once every listener ran.
  app.on('before-quit', (event) => {
    note('before-quit')
    setImmediate(() => {
      if (event.defaultPrevented) note('before-quit-prevented')
    })
  })
  app.on('will-quit', () => note('will-quit'))
  app.on('quit', (_event, exitCode) => note('quit', { exitCode }))
  process.on('exit', (code) => note('exit', { code }))

  let last = Date.now()
  const sampler = setInterval(() => {
    const now = Date.now()
    if (now - last >= STALL_MS) note('main-stall', { ms: now - last })
    last = now
  }, TICK_MS)
  sampler.unref()
} catch (error) {
  note('probe-failed', { error: String(error) })
}
