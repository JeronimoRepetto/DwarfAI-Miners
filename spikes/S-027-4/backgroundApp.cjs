'use strict'
// Spike S-027-4: a throwaway Electron app standing in for DwarfAI started by a login entry (ADR-027 item 7). It
// reports whether it was started with --background, creates the tray icon a background start shows, opens no window,
// and exits. It prints one JSON object per line on stdout; `loginEntry.os.test.ts` reads them. Started by the OS at a
// real login (`loginProbe.ts`, guide `clean-vm.md`) nobody reads stdout, so `--s0274-marker=<file>` also appends each
// line to that file.
//
// A main-process error must never open a modal on the person's desktop: every failure is printed and ends the
// process with a non-zero code.

const MARKER_FLAG = '--s0274-marker='
const marker = (process.argv.find((arg) => arg.startsWith(MARKER_FLAG)) || '').slice(
  MARKER_FLAG.length
)

const emit = (event, data) => {
  const line = `${JSON.stringify({ event, ...(data || {}) })}\n`
  process.stdout.write(line)
  if (marker) {
    try {
      process.getBuiltinModule('node:fs').appendFileSync(marker, line)
    } catch {
      // stdout still has the line.
    }
  }
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

const { app, BrowserWindow, Tray, nativeImage } = electron
const keep = { tray: null }

try {
  if (process.env.S0274_USER_DATA) app.setPath('userData', process.env.S0274_USER_DATA)
  app.on('window-all-closed', () => {})
} catch (error) {
  fail('setup', error)
}

function icon() {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4, 0xff)
  return nativeImage.createFromBitmap(pixels, { width: size, height: size })
}

async function run() {
  const background = process.argv.includes('--background')
  if (process.platform === 'darwin' && background && app.dock) app.dock.hide()
  let tray = { ok: false, message: 'not created: not a background start' }
  if (background) {
    try {
      keep.tray = new Tray(icon())
      tray = { ok: true }
    } catch (error) {
      tray = { ok: false, message: String((error && error.message) || error) }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  emit('started', {
    electron: process.versions.electron,
    startedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.getBuiltinModule('node:os').uptime()),
    background,
    windows: BrowserWindow.getAllWindows().length,
    tray
  })
  if (keep.tray) keep.tray.destroy()
  app.exit(0)
}

app.whenReady().then(run, (error) => fail('whenReady', error))
