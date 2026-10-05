'use strict'
// Spike S-018-2 (ADR-018 item 6): does a click on a toast raise the mode window on Windows 11 without a taskbar flash?
// A throwaway Electron app. It opens a plain "mode window" (or none), waits while the person moves another app in
// front of it, shows one toast, and on the click does what `revealDwarfChat` will do: restore the window if it is
// minimized, show it and focus it (creating it first when there was none). It records what Electron reports about
// focus; the taskbar flash is what the person sees, so `click-raise.md` asks for it. Run by `click-raise.md`.
//
// Environment:
//   S0182_VARIANT    behind (default): the window is open behind another app | minimized: the window is minimized |
//                    none: no window is open until the click (the windowless tray process of S-018-1)
//   S0182_MODE       click (default): show the toast and wait for the click | smoke: no toast, a hidden window, exit
//   S0182_DELAY_MS   how long it waits before the toast (default 10000), for the person to put another app in front
//   S0182_WAIT_MS    how long it waits for the click (default 120000)
//   S0182_REPORT     where to write the JSON report (no path or name of the machine is in it)
//   S0182_USER_DATA  a throwaway userData folder, so it never touches a real app's data
//
// A main-process error must never open a modal on the person's desktop: every failure is printed and ends the
// process with a non-zero code.

const { writeFileSync } = process.getBuiltinModule('node:fs')
const { release } = process.getBuiltinModule('node:os')

const events = []
const emit = (event, data) => {
  const entry = { event, atMs: Date.now() - startedAt, ...(data || {}) }
  events.push(entry)
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}
const startedAt = Date.now()

const fail = (where, error) => {
  emit('error', { where, message: String((error && error.message) || error) })
  process.exit(70)
}
process.on('uncaughtException', (error) => fail('uncaughtException', error))
process.on('unhandledRejection', (error) => fail('unhandledRejection', error))

let electron
try {
  electron = process.getBuiltinModule('node:module').createRequire(__filename)('electron')
} catch (error) {
  fail('require electron', error)
}
const { app, BrowserWindow, Notification } = electron

const variant = process.env.S0182_VARIANT || 'behind'
const mode = process.env.S0182_MODE || 'click'
const delayMs = Number(process.env.S0182_DELAY_MS || 10000)
const waitMs = Number(process.env.S0182_WAIT_MS || 120000)
const reportFile = process.env.S0182_REPORT

const keep = { window: null, notification: null }
let finished = false

try {
  if (process.env.S0182_USER_DATA) app.setPath('userData', process.env.S0182_USER_DATA)
  app.on('window-all-closed', () => {})
  if (process.platform === 'win32') app.setAppUserModelId('DwarfAI.Spike.S0182')
} catch (error) {
  fail('setup', error)
}

const PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><title>DwarfAI spike S-018-2</title>' +
      '<body style="font:16px sans-serif;padding:24px"><h1>Mode window (S-018-2)</h1>' +
      '<p>Leave this window behind another app, or minimized, until the notification appears.</p></body>'
  )

function openWindow(show) {
  const window = new BrowserWindow({
    width: 520,
    height: 300,
    show,
    title: 'DwarfAI spike S-018-2',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.on('focus', () => emit('window-focus'))
  window.on('blur', () => emit('window-blur'))
  window.loadURL(PAGE).catch((error) => fail('loadURL', error))
  keep.window = window
  return window
}

function state() {
  const window = keep.window
  if (window === null || window.isDestroyed()) return { window: false }
  return {
    window: true,
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    focused: window.isFocused(),
    focusedWindowIsMode: BrowserWindow.getFocusedWindow() === window
  }
}

function finish(reason) {
  if (finished) return
  finished = true
  emit('done', { reason, ...state() })
  if (reportFile) {
    const report = {
      spike: 'S-018-2',
      platform: process.platform,
      osRelease: release(),
      electron: process.versions.electron,
      variant,
      mode,
      events
    }
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  }
  app.exit(0)
}

/** What `revealDwarfChat` will do on the click (ADR-018 item 6): the window, restored, shown and focused. */
function reveal() {
  const window = keep.window === null || keep.window.isDestroyed() ? openWindow(true) : keep.window
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showToast() {
  const notification = new Notification({
    title: 'DwarfAI spike S-018-2',
    body: 'Click this notification: the mode window should come to the front.',
    silent: true
  })
  keep.notification = notification
  notification.on('show', () => emit('toast-show', state()))
  notification.on('failed', (_event, error) => emit('toast-failed', { message: String(error) }))
  notification.on('click', () => {
    emit('click', state())
    reveal()
    emit('after-reveal-0ms', state())
    setTimeout(() => emit('after-reveal-500ms', state()), 500)
    setTimeout(() => {
      emit('after-reveal-2000ms', state())
      finish('click')
    }, 2000)
  })
  notification.show()
  setTimeout(() => finish('timeout'), waitMs)
}

async function run() {
  emit('ready', {
    electron: process.versions.electron,
    variant,
    mode,
    notificationSupported: Notification.isSupported()
  })
  if (mode === 'smoke') {
    openWindow(false)
    emit('smoke', state())
    finish('smoke')
    return
  }
  if (variant !== 'none') {
    const window = openWindow(true)
    if (variant === 'minimized') window.once('ready-to-show', () => window.minimize())
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  emit('before-toast', state())
  showToast()
}

app.whenReady().then(run, (error) => fail('whenReady', error))
