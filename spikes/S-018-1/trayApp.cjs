'use strict'
// Spike S-018-1: a throwaway Electron app that runs in tray mode only (ADR-018 item 5). It never creates a window.
// It prints one JSON object per line on stdout; `trayNotification.os.test.ts` reads them.
//
// Environment:
//   S0181_MODE       none (default): no notification | record: show one, record the outcome | click: show one and
//                    wait for a person to click it
//   S0181_IDLE_MS    how long the process sits idle, with no window, before it shows the notification
//   S0181_WAIT_MS    how long it waits for show/click before it gives up
//   S0181_USER_DATA  a throwaway userData folder, so it never touches a real app's data
//
// A main-process error must never open a modal on the person's desktop: every failure is printed and ends the
// process with a non-zero code.

const emit = (event, data) => {
  process.stdout.write(`${JSON.stringify({ event, ...(data || {}) })}\n`)
}

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

const { app, BrowserWindow, Notification, Tray, nativeImage } = electron

const mode = process.env.S0181_MODE || 'none'
const idleMs = Number(process.env.S0181_IDLE_MS || 1500)
const waitMs = Number(process.env.S0181_WAIT_MS || 15000)
const userData = process.env.S0181_USER_DATA

const keep = { tray: null, notification: null }
let finished = false

try {
  if (userData) app.setPath('userData', userData)
  // Tray mode: the process does not end when no window is open (ADR-018 item 5).
  app.on('window-all-closed', () => {})
  if (process.platform === 'win32') app.setAppUserModelId('DwarfAI.Spike.S0181')
} catch (error) {
  fail('setup', error)
}

/** A 16 x 16 solid icon, built in memory (BGRA). */
function icon() {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 0x2f
    pixels[offset + 1] = 0x8f
    pixels[offset + 2] = 0xd9
    pixels[offset + 3] = 0xff
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size })
}

function windows() {
  return BrowserWindow.getAllWindows().length
}

function finish(reason) {
  if (finished) return
  finished = true
  emit('done', { reason, windows: windows() })
  try {
    if (keep.tray) keep.tray.destroy()
  } catch {
    // The process ends anyway.
  }
  app.exit(0)
}

function showNotification() {
  const shownAt = Date.now()
  const since = () => Date.now() - shownAt
  const notification = new Notification({
    title: 'DwarfAI spike S-018-1',
    body:
      mode === 'click'
        ? 'Click this notification to finish the check.'
        : 'Automated check. No action needed.',
    silent: true
  })
  keep.notification = notification
  notification.on('show', () => emit('show', { afterMs: since() }))
  notification.on('failed', (_event, error) =>
    emit('failed', { afterMs: since(), message: String(error) })
  )
  notification.on('close', () => emit('close', { afterMs: since() }))
  notification.on('click', () => {
    emit('click', { afterMs: since(), windows: windows() })
    finish('click')
  })
  notification.show()
  setTimeout(() => {
    emit('timeout', { waitMs })
    finish('timeout')
  }, waitMs)
}

async function run() {
  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  emit('ready', {
    electron: process.versions.electron,
    platform: process.platform,
    mode,
    windows: windows()
  })
  try {
    keep.tray = new Tray(icon())
    keep.tray.setToolTip('DwarfAI spike S-018-1')
    emit('tray', { ok: true })
  } catch (error) {
    emit('tray', { ok: false, message: String((error && error.message) || error) })
  }
  emit('support', { notificationSupported: Notification.isSupported() })
  await new Promise((resolve) => setTimeout(resolve, idleMs))
  emit('idle', { idleMs, windows: windows() })
  if (mode === 'record' || mode === 'click') showNotification()
  else finish('no notification in this mode')
}

app.whenReady().then(run, (error) => fail('whenReady', error))
