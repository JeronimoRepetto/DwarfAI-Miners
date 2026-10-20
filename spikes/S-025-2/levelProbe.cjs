'use strict'
// Spike S-025-2 (ADR-025 D1; spike register S-025-2): a throwaway Electron app that shows one small frameless,
// always-on-top window at a chosen level, so a person can check whether it stays above a full-screen app, the taskbar
// (Windows), other Spaces and full-screen Spaces (macOS) and a full-screen X11 window. The procedure is
// `window-level.md`.
//
//   pnpm exec electron spikes/S-025-2/levelProbe.cjs [--level <level>] [--all-workspaces] [--seconds <n>]
//
//   --level           an Electron always-on-top level: normal, floating, torn-off-menu, modal-panel, main-menu, status,
//                     pop-up-menu or screen-saver. Default: screen-saver on macOS, pop-up-menu elsewhere (ADR-025 D1).
//   --all-workspaces  also calls setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) (macOS and Linux).
//   --seconds         how long the window stays before the app quits by itself (default 90).
//
// The window never takes the focus (shown inactive, not focusable). It prints one JSON line per second with what
// Electron reports (isAlwaysOnTop, isVisible, bounds), and a last line when it quits. A failure is printed and ends the
// process with a non-zero code; it never opens a dialog.

const { app, BrowserWindow, screen } = process
  .getBuiltinModule('node:module')
  .createRequire(__filename)('electron')
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

const emit = (event, data) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`)
const fail = (where, error) => {
  emit('error', { where, message: String((error && error.message) || error) })
  process.exit(70)
}
process.on('uncaughtException', (error) => fail('uncaughtException', error))

const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const level =
  argument('--level') || (process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu')
const allWorkspaces = process.argv.includes('--all-workspaces')
const seconds = Number(argument('--seconds') || 90)

// A throwaway profile: the probe never touches a real app's data.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dwarfai-s0252-')))

const PAGE = (text) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#d9a441;color:#1e1e1e;font:14px sans-serif;
display:flex;align-items:center;justify-content:center}</style></head><body>${text}</body></html>`)}`

app
  .whenReady()
  .then(async () => {
    const area = screen.getPrimaryDisplay().workArea
    const size = { width: 280, height: 56 }
    const win = new BrowserWindow({
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: area.y + area.height - size.height - 8,
      ...size,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, level)
    if (allWorkspaces) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    await win.loadURL(PAGE(`S-025-2 probe · level ${level}`))
    win.showInactive()
    emit('shown', {
      platform: process.platform,
      osRelease: os.release(),
      electron: process.versions.electron,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
      level,
      allWorkspaces
    })
    let elapsed = 0
    const timer = setInterval(() => {
      elapsed += 1
      emit('tick', {
        second: elapsed,
        isAlwaysOnTop: win.isAlwaysOnTop(),
        isVisible: win.isVisible(),
        bounds: win.getBounds()
      })
      if (elapsed >= seconds) {
        clearInterval(timer)
        emit('quit', { afterSeconds: elapsed })
        app.exit(0)
      }
    }, 1000)
  })
  .catch((error) => fail('whenReady', error))
